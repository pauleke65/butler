import { Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { assetDir } from "../assets";
import type { ButlerConfig } from "../config";
import { LOG_RETENTION, demoClock } from "./lambdas";

/** Bedrock invoke permissions for an inference-profile id (`us.anthropic.x`) or a plain model id. */
export function bedrockInvokeStatement(config: ButlerConfig, modelIds: string[]): iam.PolicyStatement {
  const stack = `arn:aws:bedrock`;
  const resources = new Set<string>();
  for (const id of modelIds) {
    const base = id.replace(/^(us|eu|apac|global|us-gov)\./, "");
    resources.add(`${stack}:*::foundation-model/${base}`); // cross-region profiles route to several regions
    if (id !== base) resources.add(`${stack}:${config.region}:${config.account}:inference-profile/${id}`);
  }
  return new iam.PolicyStatement({
    sid: "InvokeConfiguredBedrockModels",
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    resources: [...resources],
  });
}

export interface RuntimesProps {
  config: ButlerConfig;
  table: dynamodb.ITable;
  gateway: agentcore.IGateway;
  policyEngine: agentcore.IPolicyEngine;
  executorFn: lambda.IFunction;
  agentSecret: secretsmanager.ISecret;
  cognito: { tokenUrl: string; discoveryUrl: string; scope: string };
  clientIds: { agent: string; executor: string; sim: string };
}

/**
 * The two AgentCore Runtimes.
 *  agent  : HTTP protocol (POST /invocations, GET /ping on 8080), IAM-authorised (the MCP server calls it with SigV4)
 *  server : MCP protocol (stateless streamable HTTP on 8000/mcp), Cognito-JWT-authorised (sim-client)
 * Artifacts are S3 code zips (direct code deployment, no Docker) unless `-c runtimeArtifact=container`.
 */
export class Runtimes extends Construct {
  readonly agent: agentcore.Runtime;
  readonly server: agentcore.Runtime;
  readonly mcpServerUrl: string;
  /** Runtime log groups. AgentCore creates them itself, so we only set their retention. */
  readonly logGroupNames: string[] = [];

  constructor(scope: Construct, id: string, props: RuntimesProps) {
    super(scope, id);
    const { config } = props;
    const stack = Stack.of(this);
    const container = config.runtimeArtifact === "container";
    const dockerExcludes = [
      ".git", ".venv", "**/node_modules", "**/cdk.out", "**/dist", "**/__pycache__", ".local-data", ".pytest_cache", ".ruff_cache",
      "addon-sim", "sim-panel", "docs", "handoff", "evals", "infra/dist", "infra/node_modules", "infra/cdk.out",
    ];

    // ── agent (Python, HTTP) ──────────────────────────────────────────
    const agentArtifact = container
      ? agentcore.AgentRuntimeArtifact.fromAsset(config.repoRoot, { file: "agent/Dockerfile", platform: Platform.LINUX_ARM64, exclude: dockerExcludes })
      : agentcore.AgentRuntimeArtifact.fromCodeAsset({
          path: assetDir(config, "agent-runtime"),
          runtime: agentcore.AgentCoreRuntime.PYTHON_3_12,
          entrypoint: ["agent_entry.py"],
        });
    this.agent = new agentcore.Runtime(this, "AgentRuntime", {
      runtimeName: `butler_${config.stage}_agent`,
      description: "Butler planner agent (Bedrock Converse loop): POST /invocations, GET /ping",
      agentRuntimeArtifact: agentArtifact,
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      // authorizerConfiguration omitted = IAM (SigV4): only the server role may invoke it
      environmentVariables: {
        STAGE: config.stage,
        LOG_LEVEL: "INFO",
        LLM_MODE: config.llmMode,
        BEDROCK_MODEL_PLANNER: config.bedrockModelPlanner,
        BEDROCK_MODEL_FAST: config.bedrockModelFast,
        TABLE_NAME: props.table.tableName,
        ...demoClock(config),
        HOUSEHOLD_ID: config.householdId,
        GATEWAY_URL: props.gateway.gatewayUrl ?? "",
        GATEWAY_ARN: props.gateway.gatewayArn,
        POLICY_ENGINE_ID: props.policyEngine.policyEngineId,
        POLICY_SETTLE_MS: String(config.policySettleMs),
        POLICY_VALIDATION_MODE: config.policyValidationMode,
        AGENT_SUB: props.clientIds.agent,
        EXECUTOR_SUB: props.clientIds.executor,
        COGNITO_TOKEN_URL: props.cognito.tokenUrl,
        AGENT_CLIENT_ID: props.clientIds.agent,
        AGENT_CLIENT_SECRET_ARN: props.agentSecret.secretArn,
        AGENT_SCOPE: props.cognito.scope,
      },
    });

    // agent role: its table, ITS OWN client secret only, Bedrock, and rule/policy management on ONE policy engine
    props.table.grantReadWriteData(this.agent.role);
    props.agentSecret.grantRead(this.agent.role);
    this.agent.role.addToPrincipalPolicy(bedrockInvokeStatement(config, [config.bedrockModelPlanner, config.bedrockModelFast]));
    const engineArn = props.policyEngine.policyEngineArn;
    this.agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "ManagePoliciesOfTheButlerEngine",
        actions: [
          "bedrock-agentcore:GetPolicyEngine",
          "bedrock-agentcore:CreatePolicy",
          "bedrock-agentcore:GetPolicy",
          "bedrock-agentcore:ListPolicies",
          "bedrock-agentcore:UpdatePolicy",
          "bedrock-agentcore:DeletePolicy",
          "bedrock-agentcore:ManageAdminPolicy",
          "bedrock-agentcore:ManageResourceScopedPolicy",
          // CreatePolicy checks the gateway named in the Cedar resource (found on the first live run).
          "bedrock-agentcore:GetGateway",
          "bedrock-agentcore:ListGatewayTargets",
          "bedrock-agentcore:GetGatewayTarget",
          // Policy creation is validated asynchronously against the gateway's tools *with the caller's permissions*;
          // without this the policy ends CREATE_FAILED "Insufficient permissions to call gateway" (live finding).
          // The gateway itself only accepts Cognito JWTs, so this grants no way to run tools.
          "bedrock-agentcore:InvokeGateway",
        ],
        resources: [engineArn, `${engineArn}/policy/*`, props.gateway.gatewayArn, `${props.gateway.gatewayArn}/target/*`],
      }),
    );

    // ── MCP server (TypeScript, MCP protocol) ─────────────────────────
    const serverArtifact = container
      ? agentcore.AgentRuntimeArtifact.fromAsset(config.repoRoot, { file: "server/Dockerfile", platform: Platform.LINUX_ARM64, exclude: dockerExcludes })
      : agentcore.AgentRuntimeArtifact.fromCodeAsset({
          path: assetDir(config, "server-runtime"),
          runtime: agentcore.AgentCoreRuntime.NODE_22,
          entrypoint: ["entry.js"],
        });
    this.server = new agentcore.Runtime(this, "ServerRuntime", {
      runtimeName: `butler_${config.stage}_server`,
      description: "Butler Alexa-facing MCP server (stateless streamable HTTP on :8000/mcp)",
      agentRuntimeArtifact: serverArtifact,
      protocolConfiguration: agentcore.ProtocolType.MCP,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingJWT(
        props.cognito.discoveryUrl,
        [props.clientIds.sim], // allowed clients (client-credentials tokens carry client_id, not aud)
        undefined,
        [props.cognito.scope],
      ),
      // The server maps the token's client_id/sub to a household (HOUSEHOLD_BY_SUB), so it needs the Authorization header.
      requestHeaderConfiguration: { allowlistedHeaders: ["Authorization"] },
      environmentVariables: {
        STAGE: config.stage,
        LOG_LEVEL: "info",
        TABLE_NAME: props.table.tableName,
        ...demoClock(config),
        AGENT_RUNTIME_ARN: this.agent.agentRuntimeArn,
        EXECUTOR_FUNCTION_NAME: props.executorFn.functionName,
        HOUSEHOLD_BY_SUB: JSON.stringify({ "*": config.householdId }),
        DEFAULT_TIMEZONE: config.defaultTimezone,
        LLM_MODE: config.llmMode,
        BEDROCK_MODEL_FAST: config.bedrockModelFast,
      },
    });
    props.table.grantReadWriteData(this.server.role);
    this.server.role.addToPrincipalPolicy(bedrockInvokeStatement(config, [config.bedrockModelFast]));
    this.agent.grantInvokeRuntime(this.server.role); // bedrock-agentcore:InvokeAgentRuntime on the agent runtime only
    props.executorFn.grantInvoke(this.server.role); // lambda:InvokeFunction on the executor only

    // AgentCore Runtime invoke URL (the runtime ARN must be URL-encoded; CloudFormation has no encode function).
    const encodedArn = Fn.join("", [
      "arn%3Aaws%3Abedrock-agentcore%3A", config.region, "%3A", config.account, "%3Aruntime%2F", this.server.agentRuntimeId,
    ]);
    this.mcpServerUrl = Fn.join("", [
      "https://bedrock-agentcore.", config.region, ".", stack.urlSuffix, "/runtimes/", encodedArn, "/invocations?qualifier=DEFAULT",
    ]);

    // AgentCore creates /aws/bedrock-agentcore/runtimes/<id>-DEFAULT itself when the runtime starts; creating it here
    // collides with that (found on the first deploy). LogRetention sets 14-day retention whether or not it exists yet.
    for (const [name, rt] of [["Agent", this.agent], ["Server", this.server]] as const) {
      const logGroupName = Fn.join("", ["/aws/bedrock-agentcore/runtimes/", rt.agentRuntimeId, "-DEFAULT"]);
      new logs.LogRetention(this, `${name}RuntimeLogRetention`, { logGroupName, retention: LOG_RETENTION, removalPolicy: RemovalPolicy.DESTROY });
      this.logGroupNames.push(logGroupName);
    }
  }
}
