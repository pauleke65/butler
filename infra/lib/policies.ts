/**
 * Cedar policies for the Gateway's policy engine: the base permit plus the five default rules (contracts 9.2, 9.4).
 *
 * The Cedar text is produced by the REAL compiler (libs/butler_rules) through scripts/gen-policies.py and committed
 * to generated/policies.json; test/policies.test.ts fails if the file drifts from `uv run` output. The Cognito
 * client ids are not known until deploy, so the file carries the `{{AGENT_SUB}}` / `{{EXECUTOR_SUB}}` placeholders
 * (the same ones the golden files use) and they are replaced by CloudFormation tokens at synth time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { INFRA_ROOT } from "./config";

export const POLICIES_PATH = path.join(INFRA_ROOT, "generated/policies.json");

/** `{rule_id: cedar}`; the key equals the `@id("...")` annotation inside the statement. */
export type PolicyMap = Record<string, string>;

export const BASE_POLICY_ID = "base-permit";
export const DEFAULT_RULE_IDS = [
  "rule_default_spend",
  "rule_default_contacts",
  "rule_default_calendar",
  "rule_default_services",
  "rule_default_refunds",
] as const;

export function loadPolicies(file: string = POLICIES_PATH): PolicyMap {
  if (!fs.existsSync(file)) {
    throw new Error(`${file} is missing. Generate it with: pnpm gen:policies (needs uv; see infra/README.md).`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PolicyMap;
  const expected = [BASE_POLICY_ID, ...DEFAULT_RULE_IDS];
  const missing = expected.filter((id) => typeof parsed[id] !== "string");
  if (missing.length) throw new Error(`${file} lacks policies: ${missing.join(", ")}. Re-run pnpm gen:policies.`);
  return parsed;
}

/** AgentCore policy names are `[A-Za-z][A-Za-z0-9_]*`, max 48; same mapping as butler_rules.policy_service.policy_name. */
export function policyName(ruleId: string): string {
  const name = ruleId.replace(/[^A-Za-z0-9_]/g, "_");
  return (/^[A-Za-z]/.test(name) ? name : `p${name}`).slice(0, 48);
}

export function bindIdentities(cedar: string, ids: { agentSub: string; executorSub: string }): string {
  const out = cedar.replaceAll("{{AGENT_SUB}}", ids.agentSub).replaceAll("{{EXECUTOR_SUB}}", ids.executorSub);
  if (out.includes("{{")) throw new Error("Unresolved {{placeholder}} left in a Cedar policy");
  return out;
}
