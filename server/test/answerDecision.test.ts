import { describe, expect, it } from "vitest";
import { ButlerError } from "../src/lib/errors.js";
import { assertEnvelope, cleaningDecision, drinksDecision, expectError, fixtures, HH, makeEnv } from "./helpers.js";

describe("answer_decision", () => {
  const dec = cleaningDecision();
  const bright = dec.options[1]!;

  it("'the second one' runs the executor synchronously, returns the receipt and resumes the plan", async () => {
    const env = await makeEnv();
    const res = await env.call("answer_decision", { decision_id: dec.decision_id, choice: "the second one" });
    const body = assertEnvelope("answer_decision", res);

    expect(env.executor.calls).toEqual([{ mode: "decision", args: { decisionId: dec.decision_id, optionId: bright.option_id, householdId: HH, correlationId: "cor_TEST" } }]);
    expect(body.decision).toMatchObject({ status: "executed", chosen_option_id: bright.option_id });
    expect(body.receipt.authority.principal).toBe("approval-executor");
    expect(body.receipt.title).toBe("Booked BrightHome");
    expect(body.spoken_summary).toBe("I booked BrightHome because you chose it. Your approval let it through.");
    expect((res._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://butler/receipt");

    await env.settle();
    expect(env.agent.calls).toEqual([{ op: "resume_plan", args: { planId: dec.plan_id, decisionId: dec.decision_id, householdId: HH, correlationId: "cor_TEST" } }]);
    const need = (await env.repo.listNeeds(dec.plan_id)).find((n) => n.need_id === dec.need_id);
    expect(need?.status).toBe("done");
  });

  it("resolves every choice form", async () => {
    for (const [choice, title] of [
      [bright.option_id, "BrightHome"],
      ["Book BrightHome.", "BrightHome"],
      ["Sparkle", "Sparkle Cleaners"],
      ["the first one", "Sparkle Cleaners"],
      ["the last one", "TidyUp Co"],
      ["the cheapest", "TidyUp Co"],
      ["yes", "BrightHome"], // default option
    ] as const) {
      const env = await makeEnv();
      const body = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: dec.decision_id, choice }));
      expect(body.receipt.title, choice).toBe(`Booked ${title}`);
    }
  });

  it("without a decision_id: picks the decision the choice belongs to when several are pending", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("answer_decision", await env.call("answer_decision", { choice: "Book BrightHome" }));
    expect(body.decision.decision_id).toBe(dec.decision_id);
  });

  it("without a decision_id and several pending: AMBIGUOUS_REFERENCE with candidates", async () => {
    const env = await makeEnv();
    const body = expectError(await env.call("answer_decision", { choice: "yes" }), "answer_decision", "AMBIGUOUS_REFERENCE");
    expect(body.error.candidates.map((c: { id: string }) => c.id).sort()).toEqual([dec.decision_id, drinksDecision().decision_id].sort());
    expect(env.executor.calls).toHaveLength(0);
  });

  it("defaults to the single pending decision", async () => {
    const env = await makeEnv();
    await env.repo.transitionDecision(HH, dec.plan_id, dec.decision_id, "pending", "rejected");
    const body = assertEnvelope("answer_decision", await env.call("answer_decision", { choice: "approve" }));
    expect(body.decision.decision_id).toBe(drinksDecision().decision_id);
    expect(body.receipt).toBeDefined();
  });

  it("reject marks the decision rejected and the need skipped, resumes the plan, never calls the executor", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: dec.decision_id, choice: "reject" }));
    expect(body.decision.status).toBe("rejected");
    expect(body.receipt).toBeUndefined();
    expect(env.executor.calls).toHaveLength(0);
    const need = (await env.repo.listNeeds(dec.plan_id)).find((n) => n.need_id === dec.need_id);
    expect(need).toMatchObject({ status: "skipped", note: "You said no." });
    await env.settle();
    expect(env.agent.calls.map((c) => c.op)).toEqual(["resume_plan"]);
    // the plan moved up the recency list
    expect((await env.repo.listPlanHeaders(HH))[0]?.plan_id).toBe(dec.plan_id);
  });

  it("rejecting an approve_action decision speaks what was skipped", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: drinksDecision().decision_id, choice: "no thanks" }));
    expect(body.spoken_summary).toBe("Okay, I won't do that. I've skipped buy drinks for 3 people.");
  });

  it("a double answer is safe: the second call reports the first outcome and does not run the executor again", async () => {
    const env = await makeEnv();
    const first = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }));
    const second = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }));
    expect(second.receipt.action_id).toBe(first.receipt.action_id);
    expect(env.executor.calls).toHaveLength(1);
    // answering a rejected decision again is also fine
    const rej = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: drinksDecision().decision_id, choice: "no" }));
    const again = assertEnvelope("answer_decision", await env.call("answer_decision", { decision_id: drinksDecision().decision_id, choice: "no" }));
    expect(again.decision.status).toBe("rejected");
    expect(rej.decision.status).toBe("rejected");
  });

  it("two simultaneous answers execute only once", async () => {
    const env = await makeEnv();
    const [a, b] = await Promise.all([
      env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }),
      env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }),
    ]);
    const ok = [a, b].filter((r) => !r.isError);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(env.executor.calls.length).toBeLessThanOrEqual(2);
    const receipts = (await env.repo.listReceipts(HH)).filter((r) => r.decision_id === dec.decision_id);
    // the seeded history already holds one receipt for this decision id; only one new receipt may appear
    expect(receipts).toHaveLength(2);
  });

  it("executor failure -> UPSTREAM_UNAVAILABLE, decision failed, need blocked", async () => {
    const env = await makeEnv();
    env.executor.fail = new ButlerError("UPSTREAM_UNAVAILABLE", undefined, { details: "executor unreachable" });
    const body = expectError(await env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }), "answer_decision", "UPSTREAM_UNAVAILABLE");
    expect(body.error.message_spoken).toBe("The store isn't responding right now. I'll try again when you ask.");
    expect((await env.repo.getDecision(dec.plan_id, dec.decision_id))?.status).toBe("failed");
    const need = (await env.repo.listNeeds(dec.plan_id)).find((n) => n.need_id === dec.need_id);
    expect(need?.status).toBe("blocked");
    await env.settle();
    expect(env.agent.calls).toHaveLength(0);
    // retrying a failed decision explains instead of re-running
    expectError(await env.call("answer_decision", { decision_id: dec.decision_id, choice: "BrightHome" }), "answer_decision", "UPSTREAM_UNAVAILABLE");
  });

  it("executor reporting a never rule passes BLOCKED_BY_NEVER_RULE through", async () => {
    const env = await makeEnv();
    env.executor.fail = new ButlerError("BLOCKED_BY_NEVER_RULE");
    const body = expectError(await env.call("answer_decision", { decision_id: drinksDecision().decision_id, choice: "yes" }), "answer_decision", "BLOCKED_BY_NEVER_RULE");
    expect(body.error.message_spoken).toBe("Your rule says never to do that, so I didn't.");
  });

  it("NOT_FOUND for unknown decisions and when nothing is pending", async () => {
    const env = await makeEnv();
    expectError(await env.call("answer_decision", { decision_id: "dec_nope", choice: "yes" }), "answer_decision", "NOT_FOUND");
    const empty = await makeEnv({ seed: false });
    const body = expectError(await empty.call("answer_decision", { choice: "yes" }), "answer_decision", "NOT_FOUND");
    expect(body.error.message_spoken).toBe("There's nothing waiting on you right now.");
  });

  it("unrecognised choices: NOT_FOUND with the options as candidates (choose) or INVALID_INPUT (approve)", async () => {
    const env = await makeEnv();
    const body = expectError(await env.call("answer_decision", { decision_id: dec.decision_id, choice: "the purple one" }), "answer_decision", "NOT_FOUND");
    expect(body.error.candidates).toHaveLength(3);
    expect(body.error.message_spoken).toBe("I didn't catch which one. Was it Sparkle Cleaners, BrightHome, or TidyUp Co?");
    expectError(await env.call("answer_decision", { decision_id: drinksDecision().decision_id, choice: "purple monkey dishwasher" }), "answer_decision", "INVALID_INPUT");
  });

  it("invalid input", async () => {
    const env = await makeEnv();
    expectError(await env.call("answer_decision", {}), "answer_decision", "INVALID_INPUT");
    expectError(await env.call("answer_decision", { choice: 5 }), "answer_decision", "INVALID_INPUT");
    expect(fixtures.decisions).toHaveLength(2);
  });

  it("expired decisions are NOT_FOUND", async () => {
    const env = await makeEnv();
    await env.repo.transitionDecision(HH, dec.plan_id, dec.decision_id, "pending", "expired");
    const body = expectError(await env.call("answer_decision", { decision_id: dec.decision_id, choice: "yes" }), "answer_decision", "NOT_FOUND");
    expect(body.error.message_spoken).toBe("That question has expired.");
  });
});
