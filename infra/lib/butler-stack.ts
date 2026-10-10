import { CfnOutput, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { ButlerConfig } from "./config";
import { GatewayWithPolicy } from "./constructs/agentcore";
import { Auth } from "./constructs/auth";
import { DataTable } from "./constructs/data";
import { ActionsLambda, DebugApi, ExecutorLambda } from "./constructs/lambdas";
import { CostBudget, SavedQueries, SesIdentities } from "./constructs/ops";
import { Runtimes } from "./constructs/runtimes";

/**
 * One stack per stage: `butler-{stage}`. Order of creation (and of CloudFormation dependencies):
 * table -> cognito+secrets -> actions Lambda -> policy engine -> gateway(+5 targets) -> policies -> executor ->
 * debug API -> agent runtime -> server runtime.
 */
export class ButlerStack extends Stack {
  readonly auth: Auth;
  readonly table: DataTable;
  readonly actions: ActionsLambda;
  readonly executor: ExecutorLambda;
  readonly debugApi: DebugApi | undefined;
  readonly gateway: GatewayWithPolicy;
  readonly runtimes: Runtimes;
  readonly ses: SesIdentities;

  constructor(scope: Construct, id: string, readonly config: ButlerConfig, props?: StackProps) {
    super(scope, id, { ...props, env: { account: config.account, region: config.region } });
    Tags.of(this).add("butler:stage", config.stage);
    Tags.of(this).add("butler:app", "butler");

    this.table = new DataTable(this, "Data", config);
    this.auth = new Auth(this, "Auth", config);
    this.ses = new SesIdentities(this, "Ses", config);

    this.actions = new ActionsLambda(this, "Actions", {
      config,
      table: this.table.table,
      googleSecret: this.auth.googleSecret,
      paymentSecret: this.auth.paymentSecret,
      sesFromAddress: config.sesFromAddress,
    });

    this.gateway = new GatewayWithPolicy(this, "Gateway", {
      config,
      actionsFn: this.actions.fn,
      discoveryUrl: this.auth.discoveryUrl,
      agentClientId: this.auth.agentClient.userPoolClientId,
      executorClientId: this.auth.executorClient.userPoolClientId,
      scope: this.auth.scope,
    });
    const gatewayUrl = this.gateway.gateway.gatewayUrl ?? "";

    this.executor = new ExecutorLambda(this, "Executor", {
      config,
      table: this.table.table,
      executorSecret: this.auth.executorSecret,
      env: {
        GATEWAY_URL: gatewayUrl,
        GATEWAY_ARN: this.gateway.gateway.gatewayArn,
        COGNITO_TOKEN_URL: this.auth.tokenUrl,
        EXECUTOR_CLIENT_ID: this.auth.executorClient.userPoolClientId,
        EXECUTOR_SCOPE: this.auth.scope,
        AGENT_SUB: this.auth.agentClient.userPoolClientId,
        EXECUTOR_SUB: this.auth.executorClient.userPoolClientId,
      },
    });

    if (config.debugApi) {
      const token = new secretsmanager.Secret(this, "DebugApiToken", {
        secretName: `butler/${config.stage}/debug-api-token`,
        description: "Bearer token of the debug API Function URL (dev/demo only). Rotate before recording (P-10).",
        generateSecretString: { passwordLength: 40, excludePunctuation: true },
        removalPolicy: RemovalPolicy.DESTROY,
      });
      this.debugApi = new DebugApi(this, "DebugApi", {
        config,
        table: this.table.table,
        // Lambda environment variables are plain text by nature; the value is resolved by CloudFormation at deploy time.
        token: token.secretValue.unsafeUnwrap(),
      });
    }

    this.runtimes = new Runtimes(this, "Runtimes", {
      config,
      table: this.table.table,
      gateway: this.gateway.gateway,
      policyEngine: this.gateway.policyEngine,
      executorFn: this.executor.fn,
      agentSecret: this.auth.agentSecret,
      cognito: { tokenUrl: this.auth.tokenUrl, discoveryUrl: this.auth.discoveryUrl, scope: this.auth.scope },
      clientIds: {
        agent: this.auth.agentClient.userPoolClientId,
        executor: this.auth.executorClient.userPoolClientId,
        sim: this.auth.simClient.userPoolClientId,
      },
    });

    new SavedQueries(this, "Queries", config, [
      this.actions.fn.logGroup.logGroupName,
      this.executor.fn.logGroup.logGroupName,
      ...this.runtimes.logGroupNames,
    ]);
    new CostBudget(this, "Budget", config);

    // ── SSM parameters: code reads these at startup (handoff 03 section 3) and the simulator config copies from them ──
    const param = (name: string, value: string, description: string): void => {
      new ssm.StringParameter(this, `Param${name.replace(/[^A-Za-z0-9]/g, "")}`, {
        parameterName: `/butler/${config.stage}/${name}`,
        stringValue: value,
        description,
      });
    };
    param("table-name", this.table.table.tableName, "DynamoDB table");
    param("cognito/token-url", this.auth.tokenUrl, "Cognito token endpoint (client credentials)");
    param("cognito/discovery-url", this.auth.discoveryUrl, "OIDC discovery URL of the user pool");
    param("cognito/scope", this.auth.scope, "OAuth scope to request");
    param("cognito/sim-client-id", this.auth.simClient.userPoolClientId, "sim-client app client id");
    param("cognito/agent-client-id", this.auth.agentClient.userPoolClientId, "butler-agent app client id (Cedar AGENT_SUB)");
    param("cognito/executor-client-id", this.auth.executorClient.userPoolClientId, "approval-executor app client id (Cedar EXECUTOR_SUB)");
    param("secrets/sim-client-arn", this.auth.simSecret.secretArn, "Secrets Manager ARN of the sim-client secret");
    param("gateway/url", gatewayUrl, "AgentCore Gateway MCP endpoint");
    param("gateway/arn", this.gateway.gateway.gatewayArn, "AgentCore Gateway ARN");
    param("gateway/id", this.gateway.gateway.gatewayId, "AgentCore Gateway id");
    param("policy-engine/id", this.gateway.policyEngine.policyEngineId, "AgentCore policy engine id");
    param("policy-engine/arn", this.gateway.policyEngine.policyEngineArn, "AgentCore policy engine ARN");
    param("agent-runtime/arn", this.runtimes.agent.agentRuntimeArn, "Butler agent runtime ARN (InvokeAgentRuntime target)");
    param("server-runtime/arn", this.runtimes.server.agentRuntimeArn, "Butler MCP server runtime ARN");
    param("mcp-server-url", this.runtimes.mcpServerUrl, "URL the simulator connects to (Bearer sim-client token)");
    param("executor/function-name", this.executor.fn.functionName, "approval executor Lambda");
    if (this.debugApi) param("debug-api/url", this.debugApi.url.url, "Debug API Function URL");

    // ── CloudFormation outputs ──
    const out = (id: string, value: string, description: string): void => {
      new CfnOutput(this, id, { value, description });
    };
    out("GatewayUrl", gatewayUrl, "AgentCore Gateway MCP endpoint");
    out("McpServerUrl", this.runtimes.mcpServerUrl, "Butler MCP server (AgentCore Runtime, MCP protocol; Bearer sim-client token)");
    if (this.debugApi) out("DebugApiUrl", this.debugApi.url.url, "Debug API (Bearer token in secret butler/{stage}/debug-api-token)");
    out("TokenUrl", this.auth.tokenUrl, "Cognito token endpoint");
    out("DiscoveryUrl", this.auth.discoveryUrl, "OIDC discovery URL");
    out("SimClientId", this.auth.simClient.userPoolClientId, "sim-client id (secret: butler/{stage}/sim-client)");
    out("AgentClientId", this.auth.agentClient.userPoolClientId, "butler-agent client id");
    out("ExecutorClientId", this.auth.executorClient.userPoolClientId, "approval-executor client id");
    out("TableName", this.table.table.tableName, "DynamoDB table");
    out("AgentRuntimeArn", this.runtimes.agent.agentRuntimeArn, "Agent runtime ARN");
    out("PolicyEngineId", this.gateway.policyEngine.policyEngineId, "Policy engine id");
  }
}
