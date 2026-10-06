import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BASE_POLICY_ID, DEFAULT_RULE_IDS, POLICIES_PATH, bindIdentities, loadPolicies, policyName } from "../lib/policies";
import { REPO_ROOT } from "../lib/config";
import { resourcesOfType, synth } from "./helpers";

const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

describe("generated/policies.json", () => {
  it.skipIf(!hasUv)("matches the output of scripts/gen-policies.py (the real compiler), so it cannot drift", () => {
    const res = spawnSync("uv", ["run", "python", "infra/scripts/gen-policies.py"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    const fresh = JSON.parse(res.stdout) as Record<string, string>;
    const committed = JSON.parse(fs.readFileSync(POLICIES_PATH, "utf8")) as Record<string, string>;
    expect(committed).toEqual(fresh);
    expect(fs.readFileSync(POLICIES_PATH, "utf8")).toBe(res.stdout); // byte-identical, so `git diff` is clean after regenerating
  });

  it("holds the base permit and the five default rules, keyed by their @id", () => {
    const policies = loadPolicies();
    expect(Object.keys(policies)).toEqual([BASE_POLICY_ID, ...DEFAULT_RULE_IDS]);
    for (const [id, cedar] of Object.entries(policies)) expect(cedar).toContain(`@id("${id}")`);
  });

  it("matches the golden Cedar files (policies/golden) apart from the rule id", () => {
    const golden = (f: string) => fs.readFileSync(path.join(REPO_ROOT, "policies/golden", f), "utf8");
    const policies = loadPolicies();
    expect(policies[BASE_POLICY_ID]).toBe(golden("base.cedar"));
    const asGolden = (id: string) => policies[id]!.replace(`@id("${id}")`, '@id("rule_golden")');
    expect(asGolden("rule_default_spend")).toBe(golden("spend_cap.cedar"));
    expect(asGolden("rule_default_contacts")).toBe(golden("ask_non_contact.cedar"));
    expect(asGolden("rule_default_calendar")).toBe(golden("protect_human_events.cedar"));
    expect(asGolden("rule_default_services")).toBe(golden("ask_tool.cedar"));
  });
});

describe("synthesized policies", () => {
  const { json } = synth();
  const policies = resourcesOfType(json, "AWS::BedrockAgentCore::Policy");
  const cedarOf = (name: string): string => {
    const p = policies.find(([, r]) => r.Properties!["Name"] === name)![1];
    const stmt = p.Properties!["Definition"].Cedar.Statement as string | { "Fn::Join": [string, unknown[]] };
    // render CloudFormation tokens as <TOKEN> so patterns can be asserted
    return typeof stmt === "string" ? stmt : stmt["Fn::Join"][1].map((x) => (typeof x === "string" ? x : "<CLIENT_ID>")).join("");
  };

  it("deploys base permit + 5 default rules (6 policies)", () => {
    expect(policies).toHaveLength(6);
    expect(policies.map(([, r]) => r.Properties!["Name"]).sort()).toEqual([policyName(BASE_POLICY_ID), ...DEFAULT_RULE_IDS].sort());
  });

  it("the base permit is a guarded permit for the two Cognito client ids", () => {
    const base = cedarOf("base_permit");
    expect(base).toMatch(/^@id\("base-permit"\)\npermit \(principal, action, resource is AgentCore::Gateway\)/);
    expect(base).toContain('principal.hasTag("sub")');
    expect(base.match(/<CLIENT_ID>/g)).toHaveLength(2);
  });

  it("every default rule is a forbid whose conditions are guarded", () => {
    for (const id of DEFAULT_RULE_IDS) {
      const cedar = cedarOf(id);
      expect(cedar, id).toMatch(/\nforbid \(/);
      expect(cedar, id).not.toMatch(/\npermit/);
      if (cedar.includes("getTag")) expect(cedar, id).toContain('principal.hasTag("sub")'); // guard every getTag with hasTag
      if (cedar.includes("context.input.")) {
        expect(cedar, id).toContain("context has input");
        const fields = [...cedar.matchAll(/context\.input\.(\w+)/g)].map((m) => m[1]!);
        for (const f of new Set(fields)) expect(cedar, `${id} guards ${f}`).toContain(`context.input has ${f}`);
      }
    }
  });

  it("encodes the contracts section 9.4 defaults", () => {
    expect(cedarOf("rule_default_spend")).toMatch(/Supplies___checkout.*Services___book_service/s);
    expect(cedarOf("rule_default_spend")).toContain("context.input.amount_minor > 5000");
    expect(cedarOf("rule_default_contacts")).toContain('action == AgentCore::Action::"Messages___send_email"');
    expect(cedarOf("rule_default_contacts")).toContain("context.input has recipient_email");
    expect(cedarOf("rule_default_calendar")).toContain('context.input.event_owner == "human"');
    expect(cedarOf("rule_default_calendar")).toMatch(/Calendar___update_event.*Calendar___delete_event/s);
    expect(cedarOf("rule_default_services")).toContain('action == AgentCore::Action::"Services___book_service"');
    expect(cedarOf("rule_default_refunds")).toContain('action == AgentCore::Action::"Supplies___refund"');
  });

  it("agent-only rules name the agent client; never-rules (calendar) name no principal", () => {
    for (const id of ["rule_default_spend", "rule_default_contacts", "rule_default_services", "rule_default_refunds"]) {
      expect(cedarOf(id), id).toContain('principal.getTag("sub") == "<CLIENT_ID>"');
    }
    expect(cedarOf("rule_default_calendar")).not.toContain("getTag");
  });

  it("uses validation mode FAIL_ON_ANY_FINDINGS by default and can be relaxed by context", () => {
    expect(policies.every(([, r]) => r.Properties!["ValidationMode"] === "FAIL_ON_ANY_FINDINGS")).toBe(true);
    const relaxed = resourcesOfType(synth({ policyValidationMode: "IGNORE_ALL_FINDINGS" }).json, "AWS::BedrockAgentCore::Policy");
    expect(relaxed.every(([, r]) => r.Properties!["ValidationMode"] === "IGNORE_ALL_FINDINGS")).toBe(true);
  });
});

describe("bindIdentities", () => {
  it("replaces both placeholders and refuses leftovers", () => {
    expect(bindIdentities("{{AGENT_SUB}}|{{EXECUTOR_SUB}}", { agentSub: "a", executorSub: "e" })).toBe("a|e");
    expect(() => bindIdentities("{{GATEWAY_ARN}}", { agentSub: "a", executorSub: "e" })).toThrow(/placeholder/);
  });

  it("maps rule ids onto valid AgentCore policy names", () => {
    expect(policyName("base-permit")).toBe("base_permit");
    expect(policyName("rule_01HZZ")).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
  });
});
