/** Fixture validation, per-tool contract checks, spoken lint on every summary, and the "never empty" fuzz (M-21, M-22). */
import { describe, expect, it } from "vitest";
import { Decision, Plan, Receipt, Rule } from "@butler/contracts";
import { lintSpoken } from "../src/lib/lintSpoken.js";
import { TOOLS } from "../src/tools/index.js";
import { assertEnvelope, cleaningDecision, fixtures, makeEnv, receiptByTitle } from "./helpers.js";

describe("contract fixtures (packages/contracts/fixtures)", () => {
  it("validate against the zod schemas", () => {
    expect(Plan.safeParse(fixtures.planHosting).success).toBe(true);
    expect(Plan.safeParse(fixtures.planAway).success).toBe(true);
    for (const d of fixtures.decisions) expect(Decision.safeParse(d).success).toBe(true);
    for (const r of fixtures.receipts) expect(Receipt.safeParse(r).success).toBe(true);
    for (const r of fixtures.rules) expect(Rule.safeParse(r).success).toBe(true);
  });

  it("have the promised shape: a hosting plan, decisions, 10 receipts incl. a DENY, 6 rules", () => {
    expect(fixtures.planHosting.kind).toBe("hosting");
    expect(fixtures.decisions.map((d) => d.kind).sort()).toEqual(["approve_action", "choose_option"]);
    expect(cleaningDecision().options).toHaveLength(3);
    expect(fixtures.receipts).toHaveLength(10);
    expect(fixtures.receipts.filter((r) => r.authority.decision === "DENY").length).toBeGreaterThanOrEqual(2);
    expect(new Set(fixtures.receipts.map((r) => r.status))).toEqual(new Set(["executed", "held_for_approval", "blocked", "failed"]));
    expect(fixtures.rules).toHaveLength(6);
    expect(new Set(fixtures.rules.map((r) => r.effect))).toEqual(new Set(["ask_first", "never"]));
  });

  it("are internally consistent (ids link up, spoken text is lint-clean)", () => {
    const actionIds = new Set(fixtures.receipts.map((r) => r.action_id));
    for (const plan of [fixtures.planHosting, fixtures.planAway]) {
      for (const n of plan.needs) {
        expect(n.plan_id).toBe(plan.plan_id);
        for (const a of n.action_ids) expect(actionIds.has(a), `${plan.title}: ${a}`).toBe(true);
      }
    }
    for (const d of fixtures.decisions) {
      const plan = [fixtures.planHosting, fixtures.planAway].find((p) => p.plan_id === d.plan_id);
      expect(plan?.needs.some((n) => n.need_id === d.need_id && n.decision_id === d.decision_id)).toBe(true);
    }
    for (const r of fixtures.receipts) expect(lintSpoken(r.spoken_summary), r.title).toEqual([]);
    for (const d of fixtures.decisions) expect(lintSpoken(d.question), d.question).toEqual([]);
    const ruleIds = new Set(fixtures.rules.map((r) => r.rule_id));
    for (const r of fixtures.receipts) for (const id of r.authority.rule_ids) expect(ruleIds.has(id), id).toBe(true);
  });
});

describe("every tool's structuredContent matches its outputSchema and passes lintSpoken", () => {
  const scenarios: Array<[string, (env: Awaited<ReturnType<typeof makeEnv>>) => Promise<unknown>]> = [
    ["handle_situation", async () => ({ situation: "six friends are coming over Friday at 7" })],
    ["get_status", async () => ({})],
    ["answer_decision", async () => ({ decision_id: cleaningDecision().decision_id, choice: "BrightHome" })],
    ["list_actions", async () => ({ filter: "might_disagree" })],
    ["explain_action", async () => ({ action_id: receiptByTitle("Bought drinks for 7").action_id })],
    ["object_to_action", async () => ({ correction: "don't buy drinks without asking" })],
    ["list_rules", async () => ({})],
    ["change_rule", async () => ({ reference: "the spending limit", change: "raise it to 80 dollars" })],
    ["undo_action", async () => ({ action_id: receiptByTitle("Bought drinks for 7").action_id })],
    ["get_ledger_page", async () => ({ limit: 5 })],
    ["get_plan", async () => ({ plan_id: fixtures.planHosting.plan_id })],
  ];

  it("covers every registered tool", () => {
    expect(scenarios.map(([n]) => n).sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  for (const [name, args] of scenarios) {
    it(name, async () => {
      const env = await makeEnv({ seed: name === "handle_situation" ? { plans: false, receipts: false } : true });
      const res = await env.call(name, await args(env));
      expect(res.isError, JSON.stringify(res.structuredContent)).toBeFalsy();
      assertEnvelope(name, res);
      await env.settle();
    });
  }
});

// ───────────────────────────── never returns empty ─────────────────────────────

/** Small deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(r: () => number, depth = 0): unknown {
  const pick = Math.floor(r() * 12);
  switch (pick) {
    case 0: return null;
    case 1: return undefined;
    case 2: return Math.floor(r() * 1000) - 500;
    case 3: return r() < 0.5;
    case 4: return "";
    case 5: return "x".repeat(Math.floor(r() * 600));
    case 6: return ["plan_nope", "act_nope", "dec_nope", "yes", "the drinks", "confirm", "NaN", "{}", "__proto__"][Math.floor(r() * 9)];
    case 7: return depth < 3 ? Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1)) : [];
    case 8: return depth < 3 ? randomObject(r, depth + 1) : {};
    case 9: return Number.NaN;
    case 10: return "🚀 emoji ✓ unicode \u0000 nul";
    default: return Math.floor(r() * 5);
  }
}

const KEYS = ["situation", "when", "plan_id", "decision_id", "choice", "action_id", "reference", "correction", "confirm", "rule_id", "change", "period", "filter", "cursor", "limit", "__proto__", "constructor", "extra"];

function randomObject(r: () => number, depth = 0): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) o[KEYS[Math.floor(r() * KEYS.length)] as string] = randomValue(r, depth);
  return o;
}

describe("never returns an empty result (M-21)", () => {
  it("random invalid inputs to every tool produce a valid envelope", async () => {
    const env = await makeEnv();
    const r = rng(20261006);
    let errors = 0;
    for (const tool of TOOLS) {
      for (let i = 0; i < 60; i++) {
        const args = r() < 0.15 ? randomValue(r) : randomObject(r);
        const res = await env.call(tool.name, args);
        assertEnvelope(tool.name, res);
        if (res.isError) errors++;
      }
    }
    await env.settle();
    expect(errors).toBeGreaterThan(300);
  });

  it("non-object arguments are INVALID_INPUT envelopes", async () => {
    const env = await makeEnv();
    for (const tool of TOOLS) {
      for (const args of [undefined, null, 5, "string", [], [1, 2]]) {
        const res = await env.call(tool.name, args);
        const body = assertEnvelope(tool.name, res);
        if (tool.name === "list_rules" || tool.name === "get_status" || tool.name === "list_actions") continue; // all-optional tools accept {}
        if (args === undefined || args === null) {
          // treated as {}: either valid or a missing-field error
          continue;
        }
        expect(res.isError, `${tool.name} ${JSON.stringify(args)}`).toBe(true);
        expect(body.error.code).toBe("INVALID_INPUT");
      }
    }
  });

  it("a throwing dependency (any thrown value) becomes an INTERNAL / UPSTREAM envelope", async () => {
    const env = await makeEnv();
    const boom = (v: unknown) => async (): Promise<never> => { throw v; };
    for (const thrown of [new Error("db exploded"), "just a string", null, undefined, { weird: true }, 42]) {
      const bad = { ...env.deps.repo } as typeof env.deps.repo;
      for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(env.deps.repo))) {
        if (key !== "constructor") (bad as unknown as Record<string, unknown>)[key] = boom(thrown);
      }
      const ctx = { ...env.ctx, deps: { ...env.deps, repo: bad } };
      for (const tool of TOOLS) {
        const res = await tool.run(tool.name === "answer_decision" ? { choice: "yes" } : tool.name === "handle_situation" ? { situation: "friends are coming over Friday" } : tool.name === "object_to_action" ? { correction: "don't buy drinks without asking" } : tool.name === "change_rule" ? { change: "remove it", reference: "drinks" } : tool.name === "get_plan" ? { plan_id: "p" } : tool.name === "explain_action" || tool.name === "undo_action" ? { action_id: "a" } : {}, ctx);
        const body = assertEnvelope(tool.name, res);
        expect(res.isError).toBe(true);
        expect(["INTERNAL", "UPSTREAM_UNAVAILABLE"]).toContain(body.error.code);
      }
    }
  });

  it("an output that breaks the contract is reported as INTERNAL, never sent", async () => {
    const env = await makeEnv();
    env.deps.repo.getPlan = (async () => ({ ...fixtures.planHosting, kind: "bogus" })) as never;
    const res = await env.call("get_plan", { plan_id: "p" });
    const body = assertEnvelope("get_plan", res);
    expect(res.isError).toBe(true);
    expect(body.error.code).toBe("INTERNAL");
  });

  it("spoken lint violations are logged at WARN but never block", async () => {
    const env = await makeEnv();
    const bad = { ...fixtures.receipts[0]!, action_id: "act_noisy", spoken_summary: "I paid $42.50. Then I did a second thing. And a third.", created_at: "2026-10-14T18:59:00+00:00" };
    await env.repo.putReceipt(bad);
    // answer through a path that returns the receipt's own text unfiltered is covered elsewhere; here the runner logs
    const spec = TOOLS.find((t) => t.name === "list_rules")!;
    const original = env.deps.repo.listRules.bind(env.deps.repo);
    env.deps.repo.listRules = async (...a) => original(...a);
    const res = await spec.run({}, env.ctx);
    expect(res.isError).toBeFalsy();
    // force a violation through the runner
    const { defineTool } = await import("../src/tools/spec.js");
    const { ListRulesInput, ListRulesOutput } = await import("@butler/contracts");
    const noisy = defineTool({
      name: "noisy", title: "n", description: "d", input: ListRulesInput, output: ListRulesOutput, annotations: {}, ui: null,
      async handler() { return { data: { spoken_summary: "One. Two. Three. $5!", allowed: [], ask_first: [], never: [] } }; },
    });
    const out = await noisy.run({}, env.ctx);
    expect(out.isError).toBeFalsy();
    expect(env.logger.entries.some((e) => e.level === "warn" && e.msg === "spoken.lint")).toBe(true);
  });
});
