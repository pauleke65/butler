/**
 * Stack configuration, read from CDK context (`-c key=value` or cdk.json "context").
 * Everything has a default so `cdk synth -c account=000000000000` works offline.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node } from "constructs";

export type Stage = "dev" | "demo";

export interface ButlerConfig {
  stage: Stage;
  /** `butler-{stage}`: prefix of every physical name (handoff/03-environment.md section 3). */
  prefix: string;
  account: string;
  region: string;
  /** SES sender identity (verification email goes here). */
  sesFromAddress: string;
  /** Extra SES identities (SES sandbox: every recipient must be verified). */
  sesRecipients: string[];
  /** Budget notifications go here; budgets are skipped (with a warning) when unset. */
  budgetEmail: string | undefined;
  /** `real` = SES + Google + payment test mode; `fake` = deterministic offline adapters (bring-up). */
  adapters: "real" | "fake";
  paymentProvider: "stripe" | "paystack";
  googleCalendarId: string;
  llmMode: "bedrock" | "offline";
  bedrockModelFast: string;
  bedrockModelPlanner: string;
  /** Wait after a policy turns ACTIVE before telling the customer a rule is in force. */
  policySettleMs: number;
  policyValidationMode: "FAIL_ON_ANY_FINDINGS" | "IGNORE_ALL_FINDINGS";
  /** `code` = AgentCore direct code deployment from S3 (no Docker); `container` = ECR image (needs Docker). */
  runtimeArtifact: "code" | "container";
  /** Unit tests only: point every asset at a tiny fixture instead of requiring `infra/dist`. */
  stubAssets: boolean;
  distDir: string;
  repoRoot: string;
  householdId: string;
  defaultTimezone: string;
  debugApi: boolean;
}

export const INFRA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(INFRA_ROOT, "..");

function str(node: Node, key: string, fallback: string): string {
  const v: unknown = node.tryGetContext(key);
  return v === undefined || v === null || v === "" ? fallback : String(v);
}

function bool(node: Node, key: string, fallback: boolean): boolean {
  const v: unknown = node.tryGetContext(key);
  if (v === undefined || v === null || v === "") return fallback;
  return v === true || String(v).toLowerCase() === "true" || String(v) === "1";
}

function oneOf<T extends string>(node: Node, key: string, allowed: readonly T[], fallback: T): T {
  const v = str(node, key, fallback);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`Context "${key}" must be one of ${allowed.join(", ")} (got "${v}").`);
  }
  return v as T;
}

export function loadConfig(node: Node): ButlerConfig {
  const stage = oneOf<Stage>(node, "stage", ["dev", "demo"], "dev");
  const account = str(node, "account", process.env["CDK_DEFAULT_ACCOUNT"] ?? "");
  if (!/^\d{12}$/.test(account)) {
    throw new Error(
      "No AWS account id. Pass `-c account=<12 digits>` (offline synth: `-c account=000000000000`) " +
        "or run with AWS credentials so the CDK CLI sets CDK_DEFAULT_ACCOUNT.",
    );
  }
  const recipients = str(node, "sesRecipients", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const policySettleMs = Number(str(node, "policySettleMs", "1500"));
  if (!Number.isFinite(policySettleMs) || policySettleMs < 0) throw new Error('Context "policySettleMs" must be >= 0.');
  return {
    stage,
    prefix: `butler-${stage}`,
    account,
    region: str(node, "region", "us-east-1"),
    sesFromAddress: str(node, "SES_FROM_ADDRESS", str(node, "sesFromAddress", "butler-demo@example.com")),
    sesRecipients: recipients,
    budgetEmail: str(node, "budgetEmail", "") || undefined,
    adapters: oneOf(node, "adapters", ["real", "fake"], "real"),
    paymentProvider: oneOf(node, "paymentProvider", ["stripe", "paystack"], "stripe"),
    googleCalendarId: str(node, "googleCalendarId", "primary"),
    llmMode: oneOf(node, "llmMode", ["bedrock", "offline"], "bedrock"),
    bedrockModelFast: str(node, "bedrockModelFast", "us.anthropic.claude-haiku-4-5-20251001-v1:0"),
    bedrockModelPlanner: str(node, "bedrockModelPlanner", "us.anthropic.claude-sonnet-5-5"),
    policySettleMs,
    policyValidationMode: oneOf(node, "policyValidationMode", ["FAIL_ON_ANY_FINDINGS", "IGNORE_ALL_FINDINGS"], "FAIL_ON_ANY_FINDINGS"),
    runtimeArtifact: oneOf(node, "runtimeArtifact", ["code", "container"], "code"),
    stubAssets: bool(node, "stubAssets", false),
    distDir: path.resolve(INFRA_ROOT, str(node, "distDir", "dist")),
    repoRoot: REPO_ROOT,
    householdId: str(node, "householdId", "hh_demo"),
    defaultTimezone: str(node, "defaultTimezone", "America/New_York"),
    debugApi: bool(node, "debugApi", true),
  };
}
