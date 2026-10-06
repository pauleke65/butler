import { describe, expect, it } from "vitest";
import type { Receipt, Rule } from "@butler/contracts";
import { ButlerError } from "../src/lib/errors.js";
import { assertEnvelope, expectError, fixtures, HH, makeEnv, receiptByTitle } from "./helpers.js";

const drinksReceipt = () => receiptByTitle("Bought drinks for 7");

describe("list_rules", () => {
  it("groups active rules: 5 ask-first/never defaults plus the drinks correction", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("list_rules", await env.call("list_rules", {}));
    expect(body.ask_first).toHaveLength(5);
    expect(body.never).toHaveLength(1);
    expect(body.allowed).toEqual([]);
    expect(body.ask_first[0].text).toBe("Ask me before buying drinks."); // newest first
    expect(body.spoken_summary).toBe("You have six rules, five ask first, one never. Your latest correction is ask me before buying drinks.");
  });

  it("excludes drafts and disabled rules; empty household speaks sensibly", async () => {
    const env = await makeEnv();
    await env.repo.putRule({ ...fixtures.rules[5]!, active: false, policy_status: "disabled" });
    await env.repo.putRule({ ...fixtures.rules[0]!, rule_id: "rule_draft", active: false, policy_status: "draft" });
    expect(assertEnvelope("list_rules", await env.call("list_rules", {})).ask_first).toHaveLength(4);
    const empty = await makeEnv({ seed: false });
    const body = assertEnvelope("list_rules", await empty.call("list_rules", {}));
    expect(body.spoken_summary).toBe("You don't have any rules yet.");
  });

  it("an allow rule lands in `allowed`", async () => {
    const env = await makeEnv({ seed: false });
    await env.repo.putRule({ ...fixtures.rules[0]!, rule_id: "rule_allow", effect: "allow" });
    expect(assertEnvelope("list_rules", await env.call("list_rules", {})).allowed).toHaveLength(1);
  });
});

describe("object_to_action (two-step confirm)", () => {
  it("draft, then confirm: the demo's drinks rule (scenes 5 and 6)", async () => {
    const env = await makeEnv({ seed: { rules: false } });
    const step1 = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "Don't buy drinks without asking me." }));
    expect(step1.needs_confirmation).toBe(true);
    expect(step1.rule).toMatchObject({ template: "ask_category", params: { category: "drinks" }, policy_status: "draft", active: false });
    expect(step1.spoken_summary).toBe("From now on, I'll ask before buying drinks. Should I make that a rule?");
    expect(await env.repo.getLatestDraft(HH)).toMatchObject({ rule_id: step1.rule.rule_id, intent: "new" });
    expect(env.agent.calls.map((c) => c.op)).toEqual(["draft_rule"]);

    const step2 = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "Don't buy drinks without asking me.", confirm: true }));
    expect(step2.needs_confirmation).toBe(false);
    expect(step2.rule).toMatchObject({ rule_id: step1.rule.rule_id, active: true, policy_status: "active" });
    expect(step2.spoken_summary).toBe("Done, from now on I'll ask before buying drinks.");
    expect(env.agent.calls.map((c) => c.op)).toEqual(["draft_rule", "apply_rule"]);
    expect((await env.repo.listRules(HH, { activeOnly: true })).map((r) => r.rule_id)).toContain(step1.rule.rule_id);
  });

  it("with a reference to the action: remembers it as the rule origin and offers an undo on confirm", async () => {
    const env = await makeEnv({ seed: { receipts: false } });
    for (const r of fixtures.receipts.filter((x) => x.plan_id !== fixtures.planAway.plan_id)) await env.repo.putReceipt(r);
    const step1 = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "don't buy drinks without asking", reference: "the drinks" }));
    expect(step1.rule.origin).toMatchObject({ type: "correction", action_id: drinksReceipt().action_id });
    const step2 = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "yes", confirm: true }));
    expect(step2.offered_undo).toEqual({ action_id: drinksReceipt().action_id, summary: "Undo: Bought drinks for 7" });
    expect(step2.spoken_summary).toBe("Done, from now on I'll ask before buying drinks. Want me to undo bought drinks for 7?");
  });

  it("no undo is offered when the original action isn't reversible", async () => {
    const env = await makeEnv();
    const invite = receiptByTitle("Invited 6 guests");
    assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "never message Jordan", action_id: invite.action_id }));
    const done = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "yes", confirm: true }));
    expect(done.offered_undo).toBeUndefined();
  });

  it("confirm without a draft -> NOT_FOUND; an expired draft (10 min) -> NOT_FOUND", async () => {
    const env = await makeEnv({ seed: { rules: false } });
    expectError(await env.call("object_to_action", { correction: "yes please", confirm: true }), "object_to_action", "NOT_FOUND");
    assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "don't buy drinks without asking" }));
    env.clock.advance(11 * 60_000);
    expectError(await env.call("object_to_action", { correction: "yes please", confirm: true }), "object_to_action", "NOT_FOUND");
  });

  it("a replayed confirm is safe (apply_rule runs once)", async () => {
    const env = await makeEnv({ seed: { rules: false } });
    assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "don't buy drinks without asking" }));
    const a = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "yes", confirm: true }));
    const b = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "yes", confirm: true }));
    expect(b.rule.rule_id).toBe(a.rule.rule_id);
    expect(env.agent.calls.filter((c) => c.op === "apply_rule")).toHaveLength(1);
  });

  it("unsupported corrections speak what Butler can do (§9.4)", async () => {
    const env = await makeEnv();
    const body = expectError(await env.call("object_to_action", { correction: "stop being so annoying about the weather" }), "object_to_action", "RULE_UNSUPPORTED");
    expect(body.error.message_spoken).toBe(
      "I can make rules about spending limits, asking before a type of purchase, asking before booking services, asking before messaging new people, or never messaging a specific person.",
    );
  });

  it("ambiguous or unknown references and ids", async () => {
    const env = await makeEnv();
    expectError(await env.call("object_to_action", { correction: "don't do that", reference: "the drinks" }), "object_to_action", "AMBIGUOUS_REFERENCE");
    expectError(await env.call("object_to_action", { correction: "don't do that", action_id: "act_nope" }), "object_to_action", "NOT_FOUND");
    expectError(await env.call("object_to_action", { correction: "x" }), "object_to_action", "INVALID_INPUT");
    expectError(await env.call("object_to_action", {}), "object_to_action", "INVALID_INPUT");
  });

  it("POLICY_PROPAGATING is a success: the rule is `creating` and the customer hears it takes a moment", async () => {
    const env = await makeEnv({ seed: { rules: false } });
    env.agent.propagating = true;
    assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "don't buy drinks without asking" }));
    const done = assertEnvelope("object_to_action", await env.call("object_to_action", { correction: "yes", confirm: true }));
    expect(done.rule.policy_status).toBe("creating");
    expect(done.spoken_summary).toBe("Done. It'll take effect in a moment.");
  });

  it("agent failures map to UPSTREAM_UNAVAILABLE", async () => {
    const env = await makeEnv();
    env.agent.nextDraftError = new ButlerError("UPSTREAM_UNAVAILABLE");
    expectError(await env.call("object_to_action", { correction: "don't buy drinks without asking" }), "object_to_action", "UPSTREAM_UNAVAILABLE");
  });
});

describe("change_rule", () => {
  const spendRule = () => fixtures.rules.find((r) => r.rule_id === "rule_default_spend") as Rule;

  it("raise the cap to 80 dollars: new policy created and active BEFORE the old one is removed (no gap)", async () => {
    const env = await makeEnv();
    const step1 = assertEnvelope("change_rule", await env.call("change_rule", { reference: "the spending limit", change: "raise it to 80 dollars" }));
    expect(step1.needs_confirmation).toBe(true);
    expect(step1.rule).toMatchObject({ template: "spend_cap", params: { cap_minor: 8000 }, policy_status: "draft" });
    expect(step1.spoken_summary).toBe("From now on, I'll ask before spending more than 80 dollars. Should I make that change?");
    const draft = env.agent.calls[0]!;
    expect(draft).toMatchObject({ op: "draft_rule", args: { baseRuleId: "rule_default_spend" } });
    expect(await env.repo.getLatestDraft(HH)).toMatchObject({ intent: "replace", replaces_rule_id: "rule_default_spend" });

    // nothing changed yet
    expect((await env.repo.getRule(HH, "rule_default_spend"))?.active).toBe(true);

    const step2 = assertEnvelope("change_rule", await env.call("change_rule", { change: "yes", confirm: true }));
    expect(step2.needs_confirmation).toBe(false);
    expect(step2.rule).toMatchObject({ rule_id: step1.rule.rule_id, active: true, policy_status: "active" });
    expect(env.agent.calls.map((c) => c.op)).toEqual(["draft_rule", "apply_rule", "remove_rule"]);
    expect(env.agent.calls[1]).toMatchObject({ args: { ruleId: step1.rule.rule_id } });
    expect(env.agent.calls[2]).toMatchObject({ args: { ruleId: "rule_default_spend" } });
    const old = await env.repo.getRule(HH, "rule_default_spend");
    expect(old).toMatchObject({ active: false, policy_status: "disabled" });

    const rules = assertEnvelope("list_rules", await env.call("list_rules", {}));
    const caps = rules.ask_first.filter((r: Rule) => r.template === "spend_cap").map((r: Rule) => r.params["cap_minor"]);
    expect(caps).toEqual([8000]);
  });

  it("does not re-remove an old rule the agent already disabled", async () => {
    const env = await makeEnv();
    assertEnvelope("change_rule", await env.call("change_rule", { rule_id: "rule_default_spend", change: "raise it to 80 dollars" }));
    const orig = env.agent.applyRule.bind(env.agent);
    env.agent.applyRule = async (ctx, id) => {
      const res = await orig(ctx, id);
      await env.repo.putRule({ ...spendRule(), active: false, policy_status: "disabled" }); // agent's _disable_replaced
      return res;
    };
    assertEnvelope("change_rule", await env.call("change_rule", { change: "yes", confirm: true }));
    expect(env.agent.calls.map((c) => c.op)).toEqual(["draft_rule", "apply_rule"]);
  });

  it("remove the drinks rule: confirm, then drinks are allowed again", async () => {
    const env = await makeEnv();
    const step1 = assertEnvelope("change_rule", await env.call("change_rule", { reference: "the drinks rule", change: "remove it" }));
    expect(step1.needs_confirmation).toBe(true);
    expect(step1.rule.template).toBe("ask_category");
    expect(step1.spoken_summary).toBe("I'll remove this rule: ask me before buying drinks. Should I go ahead?");
    expect((await env.repo.getRule(HH, step1.rule.rule_id))?.active).toBe(true);
    const step2 = assertEnvelope("change_rule", await env.call("change_rule", { change: "yes remove it", confirm: true }));
    expect(step2.rule).toMatchObject({ active: false, policy_status: "disabled" });
    expect(step2.spoken_summary).toBe("Done. I removed the rule: ask me before buying drinks.");
    expect(env.agent.calls.map((c) => c.op)).toEqual(["remove_rule"]);
    const rules = assertEnvelope("list_rules", await env.call("list_rules", {}));
    expect(rules.ask_first.some((r: Rule) => r.template === "ask_category")).toBe(false);
  });

  it("an explicit confirm with a named rule and no pending proposal acts directly", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("change_rule", await env.call("change_rule", { rule_id: "rule_default_refunds", change: "remove it", confirm: true }));
    expect(body.rule?.active).toBe(false);
    const raise = assertEnvelope("change_rule", await makeEnv().then((e) => e.call("change_rule", { rule_id: "rule_default_spend", change: "raise to 90 dollars", confirm: true })));
    expect(raise.rule).toMatchObject({ active: true, params: { cap_minor: 9000 } });
  });

  it("a stale proposal for a different rule is ignored when the caller names another rule", async () => {
    const env = await makeEnv();
    assertEnvelope("change_rule", await env.call("change_rule", { rule_id: "rule_default_spend", change: "raise it to 80 dollars" }));
    const body = assertEnvelope("change_rule", await env.call("change_rule", { rule_id: "rule_default_refunds", change: "remove it", confirm: true }));
    expect(body.rule?.rule_id).toBe("rule_default_refunds");
    expect((await env.repo.getRule(HH, "rule_default_spend"))?.active).toBe(true);
  });

  it("errors: nothing pending, unknown rule, ambiguous reference, invalid input", async () => {
    const env = await makeEnv();
    expectError(await env.call("change_rule", { change: "yes", confirm: true }), "change_rule", "NOT_FOUND");
    expectError(await env.call("change_rule", { rule_id: "rule_nope", change: "remove it" }), "change_rule", "NOT_FOUND");
    const defaults = await makeEnv({ seed: { rules: false } });
    for (const r of fixtures.rules.slice(0, 5)) await defaults.repo.putRule(r);
    const amb = expectError(await defaults.call("change_rule", { reference: "ask me", change: "remove it" }), "change_rule", "AMBIGUOUS_REFERENCE");
    expect(amb.error.candidates.length).toBeLessThanOrEqual(3);
    expectError(await env.call("change_rule", {}), "change_rule", "INVALID_INPUT");
    expectError(await env.call("change_rule", { change: "x" }), "change_rule", "INVALID_INPUT");
    expectError(await env.call("change_rule", { change: "remove the helicopter rule" }), "change_rule", "NOT_FOUND");
  });
});

describe("undo_action", () => {
  const sceneFour = async () => {
    const env = await makeEnv({ seed: { receipts: false } });
    for (const r of fixtures.receipts.filter((x) => x.plan_id !== fixtures.planAway.plan_id)) await env.repo.putReceipt(r);
    return env;
  };

  it("refunds a purchase via the executor and returns original + undo", async () => {
    const env = await sceneFour();
    const body = assertEnvelope("undo_action", await env.call("undo_action", { reference: "the drinks" }));
    expect(env.executor.calls).toEqual([{ mode: "undo", args: { actionId: drinksReceipt().action_id, householdId: HH, correlationId: "cor_TEST" } }]);
    expect(body.original.status).toBe("undone");
    expect(body.undo.undo_of).toBe(drinksReceipt().action_id);
    expect(body.undo.action.tool).toBe("Supplies___refund");
  });

  it("cancels a booking and removes a calendar event", async () => {
    const env = await sceneFour();
    const booking = assertEnvelope("undo_action", await env.call("undo_action", { action_id: receiptByTitle("Booked BrightHome").action_id }));
    expect(booking.undo.action.tool).toBe("Services___cancel_booking");
    const cal = assertEnvelope("undo_action", await env.call("undo_action", { action_id: receiptByTitle("Added dinner to your calendar").action_id }));
    expect(cal.undo.action.tool).toBe("Calendar___delete_event");
  });

  it("emails are NOT_REVERSIBLE with the contract's sentence; so are undone, failed and held receipts", async () => {
    const env = await sceneFour();
    const email = expectError(await env.call("undo_action", { action_id: receiptByTitle("Invited 6 guests").action_id }), "undo_action", "NOT_REVERSIBLE");
    expect(email.error.message_spoken).toBe("I can't undo an email once it's sent.");
    expect(env.executor.calls).toHaveLength(0);
    assertEnvelope("undo_action", await env.call("undo_action", { action_id: drinksReceipt().action_id }));
    const again = expectError(await env.call("undo_action", { action_id: drinksReceipt().action_id }), "undo_action", "NOT_REVERSIBLE");
    expect(again.error.message_spoken).toBe("That one has already been undone.");
    expectError(await env.call("undo_action", { action_id: receiptByTitle("Tried to buy dishwasher tablets").action_id }), "undo_action", "NOT_REVERSIBLE");
    await env.repo.putReceipt(receiptByTitle("Held a drinks purchase"));
    expectError(await env.call("undo_action", { action_id: receiptByTitle("Held a drinks purchase").action_id }), "undo_action", "NOT_REVERSIBLE");
  });

  it("errors: not found, ambiguous, invalid, executor down", async () => {
    const env = await makeEnv();
    expectError(await env.call("undo_action", { action_id: "act_nope" }), "undo_action", "NOT_FOUND");
    expectError(await env.call("undo_action", { reference: "the drinks" }), "undo_action", "AMBIGUOUS_REFERENCE");
    expectError(await env.call("undo_action", {}), "undo_action", "INVALID_INPUT");
    env.executor.fail = new ButlerError("UPSTREAM_UNAVAILABLE");
    expectError(await env.call("undo_action", { action_id: drinksReceipt().action_id }), "undo_action", "UPSTREAM_UNAVAILABLE");
  });

  it("is declared destructive", async () => {
    const { TOOL_BY_NAME } = await import("../src/tools/index.js");
    expect(TOOL_BY_NAME.get("undo_action")?.annotations.destructiveHint).toBe(true);
    void ({} as Receipt);
  });
});

describe("get_plan (app-only)", () => {
  it("returns a plan or NOT_FOUND", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("get_plan", await env.call("get_plan", { plan_id: fixtures.planHosting.plan_id }));
    expect(body.plan.title).toBe("Dinner for 6, Friday 7 PM");
    expectError(await env.call("get_plan", { plan_id: "plan_nope" }), "get_plan", "NOT_FOUND");
    expectError(await env.call("get_plan", {}), "get_plan", "INVALID_INPUT");
  });
});
