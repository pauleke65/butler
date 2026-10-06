import { describe, expect, it } from "vitest";
import { assertEnvelope, cleaningDecision, drinksDecision, expectError, fixtures, HH, makeEnv } from "./helpers.js";

const uri = (res: { _meta?: unknown }): string => (res._meta as { ui: { resourceUri: string } }).ui.resourceUri;

describe("get_status", () => {
  it("defaults to the most recently updated active plan and lists its pending decisions", async () => {
    const env = await makeEnv();
    const res = await env.call("get_status", {});
    const body = assertEnvelope("get_status", res);
    expect(body.plan.plan_id).toBe(fixtures.planAway.plan_id);
    expect(body.pending_decisions.map((d: { decision_id: string }) => d.decision_id)).toEqual([drinksDecision().decision_id]);
    expect(uri(res)).toBe("ui://butler/plan"); // approve_action is not an options view
    expect(body.spoken_summary).toContain("One thing for you: should I buy drinks");
  });

  it("switches to the options view when exactly one choose_option decision is pending", async () => {
    const env = await makeEnv();
    const res = await env.call("get_status", { plan_id: fixtures.planHosting.plan_id });
    const body = assertEnvelope("get_status", res);
    expect(uri(res)).toBe("ui://butler/options");
    expect(body.pending_decisions).toHaveLength(1);
    expect(body.pending_decisions[0].options).toHaveLength(3);
    expect(body.spoken_summary).toBe(
      "I invited 6 guests, added dinner to your calendar and ordered food and drinks. One thing for you: which cleaner should I book?",
    );
  });

  it("limits to 3 pending decisions, oldest first, and plan view when several are pending", async () => {
    const env = await makeEnv();
    const base = cleaningDecision();
    for (let i = 0; i < 4; i++) {
      await env.repo.putDecision(HH, { ...base, decision_id: `dec_extra_${i}`, created_at: `2026-10-14T19:0${i}:00+00:00` });
    }
    const res = await env.call("get_status", { plan_id: fixtures.planHosting.plan_id });
    const body = assertEnvelope("get_status", res);
    expect(body.pending_decisions).toHaveLength(3);
    const created = body.pending_decisions.map((d: { created_at: string }) => d.created_at);
    expect(created).toEqual([...created].sort());
    expect(uri(res)).toBe("ui://butler/plan");
  });

  it("'done since last check' is correct across two calls", async () => {
    const env = await makeEnv();
    const planId = fixtures.planHosting.plan_id;
    const first = assertEnvelope("get_status", await env.call("get_status", { plan_id: planId }));
    expect(first.done_since_last_check.map((d: { label: string }) => d.label)).toEqual([
      "Invite 6 guests",
      "Add dinner to your calendar",
      "Order food and drinks",
    ]);
    expect(first.done_since_last_check[0].note).toBe("Sent to 6 people at 2:05 PM");

    // read time is stamped without touching updated_at
    const stored = await env.repo.getPlan(HH, planId);
    expect(stored?.last_status_read_at).toBe("2026-10-14T19:00:00+00:00");
    expect(stored?.updated_at).toBe(fixtures.planHosting.updated_at);

    env.clock.advance(60_000);
    const second = assertEnvelope("get_status", await env.call("get_status", { plan_id: planId }));
    expect(second.done_since_last_check).toEqual([]);
    expect(second.spoken_summary).toMatch(/^Nothing new since you last asked\./);

    // a need finishing later shows up on the next call
    env.clock.advance(60_000);
    const needs = await env.repo.listNeeds(planId);
    const cleaning = needs.find((n) => n.capability === "services")!;
    await env.repo.putNeed({ ...cleaning, status: "done", note: "Booked BrightHome", updated_at: "2026-10-14T19:02:30+00:00" });
    await env.repo.transitionDecision(HH, planId, cleaningDecision().decision_id, "pending", "executed");
    const third = assertEnvelope("get_status", await env.call("get_status", { plan_id: planId }));
    expect(third.done_since_last_check.map((d: { label: string }) => d.label)).toEqual(["Book a cleaner"]);
    expect(third.spoken_summary).toBe("I booked a cleaner.");
  });

  it("NO_ACTIVE_PLAN when there is nothing in progress", async () => {
    const env = await makeEnv({ seed: false });
    expectError(await env.call("get_status", {}), "get_status", "NO_ACTIVE_PLAN");

    await env.repo.putPlan({ ...fixtures.planHosting, status: "complete" });
    expectError(await env.call("get_status", {}), "get_status", "NO_ACTIVE_PLAN");
  });

  it("NOT_FOUND for an unknown plan and for another household's plan", async () => {
    const env = await makeEnv();
    expectError(await env.call("get_status", { plan_id: "plan_nope" }), "get_status", "NOT_FOUND");
    const other = await makeEnv({ seed: false });
    await other.repo.putPlan({ ...fixtures.planHosting, household_id: "hh_other" });
    expectError(await other.call("get_status", { plan_id: fixtures.planHosting.plan_id }), "get_status", "NOT_FOUND");
  });

  it("rejects non-string plan ids", async () => {
    const env = await makeEnv();
    expectError(await env.call("get_status", { plan_id: 12 }), "get_status", "INVALID_INPUT");
  });
});
