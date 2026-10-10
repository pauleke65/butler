import { Match } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_TOOL_NAMES } from "../lib/tool-schemas";
import {
  actionsOf,
  idByPath,
  readableSecrets,
  resourcesOf,
  resourcesOfType,
  statementsOfRole,
  synth,
  type Synth,
} from "./helpers";

let s: Synth;
beforeAll(() => {
  s = synth();
});

describe("DynamoDB (contracts section 10)", () => {
  it("has the single table with PK/SK, GSI1 (ALL), TTL, PITR, on-demand, stream NEW_IMAGE", () => {
    s.template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "butler-dev",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
      ]),
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      StreamSpecification: { StreamViewType: "NEW_IMAGE" },
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    });
    const table = resourcesOfType(s.json, "AWS::DynamoDB::Table")[0]![1] as { DeletionPolicy?: string };
    expect(table.DeletionPolicy).toBe("Delete"); // dev/demo: `cdk destroy` must work
  });
});

describe("Cognito (decision D9)", () => {
  it("has a resource server with scope butler/invoke and a domain", () => {
    s.template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: "butler",
      Scopes: [{ ScopeName: "invoke", ScopeDescription: Match.anyValue() }],
    });
    s.template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });

  it("has exactly the three client-credentials app clients, with secrets", () => {
    const clients = resourcesOfType(s.json, "AWS::Cognito::UserPoolClient");
    expect(clients.map(([, c]) => c.Properties!["ClientName"]).sort()).toEqual(["approval-executor", "butler-agent", "sim-client"]);
    for (const [, c] of clients) {
      expect(c.Properties!["GenerateSecret"]).toBe(true);
      expect(c.Properties!["AllowedOAuthFlows"]).toEqual(["client_credentials"]);
      expect(c.Properties!["AllowedOAuthFlowsUserPoolClient"]).toBe(true);
      expect(JSON.stringify(c.Properties!["AllowedOAuthScopes"])).toContain("invoke");
    }
  });

  it("stores client secrets and placeholder secrets in Secrets Manager under butler/{stage}/", () => {
    const names = resourcesOfType(s.json, "AWS::SecretsManager::Secret").map(([, r]) => r.Properties!["Name"]);
    for (const n of ["agent-client", "executor-client", "sim-client", "google-refresh-token", "payment-key", "debug-api-token"]) {
      expect(names).toContain(`butler/dev/${n}`);
    }
  });

  it("publishes client ids, token URL and discovery URL to SSM /butler/dev/*", () => {
    const names = resourcesOfType(s.json, "AWS::SSM::Parameter").map(([, r]) => r.Properties!["Name"]);
    for (const n of [
      "cognito/sim-client-id", "cognito/agent-client-id", "cognito/executor-client-id", "cognito/token-url", "cognito/discovery-url",
      "gateway/url", "gateway/arn", "policy-engine/id", "agent-runtime/arn", "mcp-server-url", "debug-api/url", "table-name",
    ]) {
      expect(names).toContain(`/butler/dev/${n}`);
    }
  });
});

describe("Lambdas", () => {
  const ours = () => resourcesOfType(s.json, "AWS::Lambda::Function").filter(([, r]) => String(r.Properties!["FunctionName"] ?? "").startsWith("butler-dev-"));

  it("are Python 3.12 on arm64", () => {
    const fns = ours();
    expect(fns.map(([, r]) => r.Properties!["FunctionName"]).sort()).toEqual(["butler-dev-actions", "butler-dev-approval-executor", "butler-dev-debug-api"]);
    for (const [, f] of fns) {
      expect(f.Properties!["Runtime"]).toBe("python3.12");
      expect(f.Properties!["Architectures"]).toEqual(["arm64"]);
    }
  });

  it("use the thin entry modules", () => {
    const handler = (name: string) => ours().find(([, r]) => r.Properties!["FunctionName"] === name)![1].Properties!["Handler"];
    expect(handler("butler-dev-actions")).toBe("butler_action_handlers.lambda_handler.handler");
    expect(handler("butler-dev-approval-executor")).toBe("butler_executor.lambda_handler.handler");
    expect(handler("butler-dev-debug-api")).toBe("debug_api.core.lambda_handler");
  });

  it("have the environment the application code reads", () => {
    const env = (name: string) => ours().find(([, r]) => r.Properties!["FunctionName"] === name)![1].Properties!["Environment"].Variables as Record<string, unknown>;
    expect(Object.keys(env("butler-dev-actions"))).toEqual(
      expect.arrayContaining(["STAGE", "TABLE_NAME", "HOUSEHOLD_ID", "ADAPTERS", "SES_FROM", "GOOGLE_OAUTH_SECRET_ID", "PAYMENT_SECRET_ARN", "PAYMENT_PROVIDER"]),
    );
    expect(Object.keys(env("butler-dev-approval-executor"))).toEqual(
      expect.arrayContaining(["TABLE_NAME", "GATEWAY_URL", "COGNITO_TOKEN_URL", "EXECUTOR_CLIENT_ID", "EXECUTOR_CLIENT_SECRET_ARN", "EXECUTOR_SCOPE"]),
    );
    expect(Object.keys(env("butler-dev-debug-api"))).toEqual(expect.arrayContaining(["TABLE_NAME", "DEBUG_API_TOKEN"]));
    // no secret VALUES for the executor or actions functions: only ARNs
    expect(JSON.stringify(env("butler-dev-approval-executor"))).not.toMatch(/EXECUTOR_CLIENT_SECRET"/);
  });

  it("debug API is a Function URL with no IAM auth, read-only on the table", () => {
    s.template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
    const role = idByPath(s.json, "DebugApi/Function/ServiceRole/Resource");
    const actions = statementsOfRole(s.json, role).flatMap(actionsOf);
    expect(actions).toContain("dynamodb:GetItem");
    expect(actions).not.toContain("dynamodb:PutItem");
    expect(actions).not.toContain("dynamodb:DeleteItem");
  });

  it("retain logs for 14 days", () => {
    const groups = resourcesOfType(s.json, "AWS::Logs::LogGroup");
    expect(groups.length).toBeGreaterThanOrEqual(3); // the three Lambdas
    for (const [, g] of groups) expect(g.Properties!["RetentionInDays"]).toBe(14);
    // AgentCore creates the two runtime log groups itself; we only set their retention (Custom::LogRetention).
    const retention = resourcesOfType(s.json, "Custom::LogRetention");
    expect(retention.length).toBe(2);
    for (const [, r] of retention) expect(r.Properties!["RetentionInDays"]).toBe(14);
  });
});

describe("least privilege", () => {
  const secretId = (suffix: string) => idByPath(s.json, `${suffix}/Resource`);

  it("executor role reads ONLY the executor secret (not the agent secret)", () => {
    const role = idByPath(s.json, "Executor/Function/ServiceRole/Resource");
    expect(readableSecrets(s.json, role)).toEqual([secretId("Auth/executor-clientSecret")]);
    expect(readableSecrets(s.json, role)).not.toContain(secretId("Auth/agent-clientSecret"));
  });

  it("agent runtime role reads ONLY the agent secret (not the executor secret)", () => {
    const role = idByPath(s.json, "Runtimes/AgentRuntime/ExecutionRole/Resource");
    expect(readableSecrets(s.json, role)).toEqual([secretId("Auth/agent-clientSecret")]);
    expect(readableSecrets(s.json, role)).not.toContain(secretId("Auth/executor-clientSecret"));
  });

  it("actions role reads only the Google and payment secrets", () => {
    const role = idByPath(s.json, "Actions/Function/ServiceRole/Resource");
    expect(readableSecrets(s.json, role).sort()).toEqual([secretId("Auth/GoogleSecret"), secretId("Auth/PaymentSecret")].sort());
  });

  it("server runtime role reads no secret; may invoke the agent runtime and the executor, nothing else of note", () => {
    const role = idByPath(s.json, "Runtimes/ServerRuntime/ExecutionRole/Resource");
    expect(readableSecrets(s.json, role)).toEqual([]);
    const actions = statementsOfRole(s.json, role).flatMap(actionsOf);
    expect(actions).toContain("bedrock-agentcore:InvokeAgentRuntime");
    expect(actions).toContain("lambda:InvokeFunction");
    expect(actions).not.toContain("bedrock-agentcore:CreatePolicy");
  });

  it("only the agent role can manage policies of the engine", () => {
    const agent = statementsOfRole(s.json, idByPath(s.json, "Runtimes/AgentRuntime/ExecutionRole/Resource")).flatMap(actionsOf);
    expect(agent).toContain("bedrock-agentcore:CreatePolicy");
    for (const path of ["Executor/Function/ServiceRole/Resource", "Actions/Function/ServiceRole/Resource", "DebugApi/Function/ServiceRole/Resource"]) {
      expect(statementsOfRole(s.json, idByPath(s.json, path)).flatMap(actionsOf)).not.toContain("bedrock-agentcore:CreatePolicy");
    }
  });

  it("SES sending is limited to the configured identity", () => {
    const role = idByPath(s.json, "Actions/Function/ServiceRole/Resource");
    const ses = statementsOfRole(s.json, role).filter((st) => actionsOf(st).some((a) => a.startsWith("ses:")));
    expect(ses).toHaveLength(1);
    expect(JSON.stringify(ses[0]!.Resource)).toContain("identity/butler@example.org");
    expect(JSON.stringify(ses[0]!.Condition)).toContain("butler@example.org");
  });

  it("no statement on secretsmanager or dynamodb uses a bare '*' resource, anywhere", () => {
    for (const [id, res] of resourcesOfType(s.json, "AWS::IAM::Policy")) {
      for (const st of res.Properties!["PolicyDocument"].Statement as Array<{ Action: string | string[]; Resource: unknown }>) {
        const acts = actionsOf(st as never);
        if (!acts.some((a) => a.startsWith("secretsmanager:") || a.startsWith("dynamodb:"))) continue;
        for (const r of resourcesOf(st as never)) expect(r, `${id} ${acts.join(",")}`).not.toBe("*");
      }
    }
  });

  it("Bedrock access is limited to the configured models", () => {
    const role = idByPath(s.json, "Runtimes/AgentRuntime/ExecutionRole/Resource");
    const st = statementsOfRole(s.json, role).find((x) => actionsOf(x).includes("bedrock:InvokeModel"))!;
    const res = resourcesOf(st).map(String);
    expect(res).toContain("arn:aws:bedrock:us-east-1:000000000000:inference-profile/us.amazon.nova-2-lite-v1:0");
    expect(res.every((r) => r.includes("amazon.nova-2-lite-v1:0"))).toBe(true);
  });
});

describe("AgentCore Gateway and Policy (decisions D6, D9)", () => {
  it("has one Gateway with custom JWT auth for the agent and executor clients only", () => {
    const gws = resourcesOfType(s.json, "AWS::BedrockAgentCore::Gateway");
    expect(gws).toHaveLength(1);
    const props = gws[0]![1].Properties!;
    expect(props["AuthorizerType"]).toBe("CUSTOM_JWT");
    const clients = props["AuthorizerConfiguration"].CustomJWTAuthorizer.AllowedClients as Array<{ Ref: string }>;
    expect(clients.map((c) => c.Ref).sort()).toEqual([idByPath(s.json, "Auth/UserPool/butler-agent/Resource"), idByPath(s.json, "Auth/UserPool/approval-executor/Resource")].sort());
    expect(props["AuthorizerConfiguration"].CustomJWTAuthorizer.AllowedScopes).toEqual(["butler/invoke"]);
    expect(props["ProtocolConfiguration"].Mcp.SearchType).toBeUndefined(); // tools/list must list exactly our tools
  });

  it("attaches the policy engine in ENFORCE mode", () => {
    s.template.hasResourceProperties("AWS::BedrockAgentCore::Gateway", {
      PolicyEngineConfiguration: { Mode: "ENFORCE", Arn: Match.anyValue() },
    });
    s.template.hasResourceProperties("AWS::BedrockAgentCore::PolicyEngine", { Name: "butler_dev_policies" });
  });

  it("has exactly five Lambda targets whose tools are the 12 contract tools", () => {
    const targets = resourcesOfType(s.json, "AWS::BedrockAgentCore::GatewayTarget");
    expect(targets).toHaveLength(5);
    expect(targets.map(([, t]) => t.Properties!["Name"]).sort()).toEqual(["Calendar", "Context", "Messages", "Services", "Supplies"]);
    const full: string[] = [];
    for (const [, t] of targets) {
      const lambda = t.Properties!["TargetConfiguration"].Mcp.Lambda;
      expect(JSON.stringify(lambda.LambdaArn)).toContain("ActionsFunction"); // all five share ONE function
      for (const tool of lambda.ToolSchema.InlinePayload as Array<{ Name: string }>) full.push(`${t.Properties!["Name"]}___${tool.Name}`);
    }
    expect(full.sort()).toEqual([...GATEWAY_TOOL_NAMES].sort());
  });

  it("the Gateway role can invoke the actions function", () => {
    const role = idByPath(s.json, "Gateway/ServiceRole/Resource");
    const st = statementsOfRole(s.json, role).find((x) => actionsOf(x).includes("lambda:InvokeFunction"));
    expect(st).toBeDefined();
    expect(JSON.stringify(st!.Resource)).toContain("ActionsFunction");
  });

  it("policies are created after the gateway and its targets exist", () => {
    for (const [, p] of resourcesOfType(s.json, "AWS::BedrockAgentCore::Policy")) {
      const deps = ([] as string[]).concat(p.DependsOn ?? []);
      expect(deps.filter((d) => d.includes("Target")).length).toBe(5);
      expect(deps.some((d) => d.startsWith("Gateway0") || /^Gateway[0-9A-F]{8}$/.test(d))).toBe(true);
    }
  });
});

describe("runtimes (decision D18, tickets A-8 and M-23)", () => {
  it("agent: HTTP protocol, IAM auth, Python code deployment", () => {
    s.template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      AgentRuntimeName: "butler_dev_agent",
      ProtocolConfiguration: "HTTP",
      AgentRuntimeArtifact: { CodeConfiguration: { Runtime: "PYTHON_3_12", EntryPoint: ["agent_entry.py"], Code: { S3: Match.anyValue() } } },
    });
    const agent = resourcesOfType(s.json, "AWS::BedrockAgentCore::Runtime").find(([, r]) => r.Properties!["AgentRuntimeName"] === "butler_dev_agent")![1];
    expect(agent.Properties!["AuthorizerConfiguration"]).toBeUndefined(); // default = IAM
    expect(Object.keys(agent.Properties!["EnvironmentVariables"])).toEqual(
      expect.arrayContaining([
        "TABLE_NAME", "GATEWAY_URL", "GATEWAY_ARN", "POLICY_ENGINE_ID", "POLICY_SETTLE_MS", "AGENT_SUB", "EXECUTOR_SUB", "COGNITO_TOKEN_URL",
        "AGENT_CLIENT_ID", "AGENT_CLIENT_SECRET_ARN", "BEDROCK_MODEL_PLANNER", "BEDROCK_MODEL_FAST", "LLM_MODE", "STAGE",
      ]),
    );
    const sub = agent.Properties!["EnvironmentVariables"];
    expect(sub["AGENT_SUB"]).toEqual(sub["AGENT_CLIENT_ID"]); // Cedar identity == Cognito client id
    expect(sub["AGENT_SUB"]).not.toEqual(sub["EXECUTOR_SUB"]);
  });

  it("server: MCP protocol, Cognito JWT for sim-client only, Node code deployment, forwards Authorization", () => {
    const server = resourcesOfType(s.json, "AWS::BedrockAgentCore::Runtime").find(([, r]) => r.Properties!["AgentRuntimeName"] === "butler_dev_server")![1];
    expect(server.Properties!["ProtocolConfiguration"]).toBe("MCP");
    expect(server.Properties!["AgentRuntimeArtifact"].CodeConfiguration.Runtime).toBe("NODE_22");
    const jwt = server.Properties!["AuthorizerConfiguration"].CustomJWTAuthorizer;
    expect(jwt.AllowedClients).toEqual([{ Ref: idByPath(s.json, "Auth/UserPool/sim-client/Resource") }]);
    expect(server.Properties!["RequestHeaderConfiguration"].RequestHeaderAllowlist).toContain("Authorization");
    expect(Object.keys(server.Properties!["EnvironmentVariables"])).toEqual(
      expect.arrayContaining(["TABLE_NAME", "AGENT_RUNTIME_ARN", "EXECUTOR_FUNCTION_NAME", "HOUSEHOLD_BY_SUB", "DEFAULT_TIMEZONE", "BEDROCK_MODEL_FAST"]),
    );
  });
});

describe("ops (ticket P-1, P-7)", () => {
  it("creates the SES identities", () => {
    const ids = resourcesOfType(s.json, "AWS::SES::EmailIdentity").map(([, r]) => r.Properties!["EmailIdentity"]);
    expect(ids.sort()).toEqual(["butler@example.org", "tester@example.org"]);
  });

  it("creates budget alarms at $50 and $100", () => {
    s.template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetLimit: { Amount: 100, Unit: "USD" }, TimeUnit: "MONTHLY", BudgetType: "COST" },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 50, ThresholdType: "PERCENTAGE" }), Subscribers: [{ SubscriptionType: "EMAIL", Address: "budget@example.org" }] }),
        Match.objectLike({ Notification: Match.objectLike({ Threshold: 100, ThresholdType: "PERCENTAGE" }) }),
      ],
    });
  });

  it("outputs the gateway URL, MCP server URL and debug API URL", () => {
    expect(Object.keys(s.json.Outputs ?? {})).toEqual(expect.arrayContaining(["GatewayUrl", "McpServerUrl", "DebugApiUrl"]));
  });

  it("saves the three Logs Insights queries", () => {
    expect(resourcesOfType(s.json, "AWS::Logs::QueryDefinition")).toHaveLength(3);
  });
});

describe("stages and config", () => {
  it("the demo stage renames everything", () => {
    const demo = synth({ stage: "demo" });
    demo.template.hasResourceProperties("AWS::DynamoDB::Table", { TableName: "butler-demo" });
    demo.template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "butler-demo-actions" });
    const names = resourcesOfType(demo.json, "AWS::SecretsManager::Secret").map(([, r]) => r.Properties!["Name"]);
    expect(names).toContain("butler/demo/agent-client");
  });

  it("debugApi=false drops the debug Lambda", () => {
    const t = synth({ debugApi: "false" });
    t.template.resourceCountIs("AWS::Lambda::Url", 0);
  });

  it("adapters=fake is passed to the actions function", () => {
    const t = synth({ adapters: "fake" });
    t.template.hasResourceProperties("AWS::Lambda::Function", { FunctionName: "butler-dev-actions", Environment: { Variables: Match.objectLike({ ADAPTERS: "fake" }) } });
  });

  it("warns instead of failing when no budget email is configured", () => {
    const t = synth({ budgetEmail: "" });
    t.template.resourceCountIs("AWS::Budgets::Budget", 0);
  });

  it("rejects an invalid stage", () => {
    expect(() => synth({ stage: "prod" })).toThrow(/stage/);
  });

  it("needs an account id", () => {
    expect(() => synth({ account: "" })).toThrow(/account/i);
  });
});
