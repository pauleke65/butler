/** Environment-driven configuration (05-local-build.md §1). */
export type LlmMode = "offline" | "bedrock";

export interface Config {
  stage: string;
  port: number;
  region: string;
  tableName: string;
  dynamodbEndpoint: string | undefined;
  agentLocalUrl: string | undefined;
  agentRuntimeArn: string | undefined;
  executorLocalUrl: string | undefined;
  executorFunctionName: string | undefined;
  llmMode: LlmMode;
  bedrockModelFast: string;
  householdBySub: Record<string, string>;
  /** Timezone used when the household record is missing. */
  defaultTimezone: string;
  uiDistDir: string | undefined;
  /** Needs-pass hard timeout inside the Bedrock implementation. */
  needsPassTimeoutMs: number;
  /** Total latency budget for handle_situation (contracts §3.2). */
  handleSituationBudgetMs: number;
  executorTimeoutMs: number;
  /** Respond with JSON instead of an SSE stream for POST /mcp. */
  jsonResponse: boolean;
  /** Pinned "now" (ISO) for demos and tests. */
  nowOverride: string | undefined;
  corsOrigin: string | undefined;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const LOCAL_SIM_TOKEN = "local-sim-token";

function parseHouseholdMap(raw: string | undefined): Record<string, string> {
  if (!raw) return { "*": "hh_demo" };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
      if (Object.keys(out).length > 0) return out;
    }
  } catch {
    /* fall through */
  }
  return { "*": "hh_demo" };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = env["LLM_MODE"] === "bedrock" ? "bedrock" : "offline";
  const level = env["LOG_LEVEL"];
  return {
    stage: env["STAGE"] ?? "local",
    port: Number(env["PORT"] ?? 8000),
    region: env["AWS_REGION"] ?? "us-east-1",
    tableName: env["TABLE_NAME"] ?? "butler-local",
    dynamodbEndpoint: env["DYNAMODB_ENDPOINT"] || undefined,
    agentLocalUrl: env["AGENT_LOCAL_URL"] || undefined,
    agentRuntimeArn: env["AGENT_RUNTIME_ARN"] || undefined,
    executorLocalUrl: env["EXECUTOR_LOCAL_URL"] || undefined,
    executorFunctionName: env["EXECUTOR_FUNCTION_NAME"] || undefined,
    llmMode: mode,
    bedrockModelFast: env["BEDROCK_MODEL_FAST"] ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    householdBySub: parseHouseholdMap(env["HOUSEHOLD_BY_SUB"]),
    defaultTimezone: env["DEFAULT_TIMEZONE"] ?? "America/New_York",
    uiDistDir: env["UI_DIST_DIR"] || undefined,
    needsPassTimeoutMs: Number(env["NEEDS_PASS_TIMEOUT_MS"] ?? 2500),
    handleSituationBudgetMs: Number(env["HANDLE_SITUATION_BUDGET_MS"] ?? 2500),
    executorTimeoutMs: Number(env["EXECUTOR_TIMEOUT_MS"] ?? 8000),
    jsonResponse: (env["MCP_JSON_RESPONSE"] ?? "true") !== "false",
    nowOverride: env["BUTLER_NOW"] || undefined,
    corsOrigin: env["CORS_ORIGIN"] || undefined,
    logLevel: level === "debug" || level === "warn" || level === "error" ? level : "info",
  };
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}), stage: "local", llmMode: "offline", ...overrides };
}
