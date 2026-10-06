import { describe, expect, it } from "vitest";
import { ButlerError } from "../src/lib/errors.js";
import type { NeedsPass } from "../src/lib/needsPass.js";
import { assertEnvelope, expectError, fixtures, HH, makeEnv, NOW } from "./helpers.js";

const GOLDEN = "Tell Butler six friends from the dinner crew are coming over Friday at 7.";

describe("handle_situation", () => {
  it("creates a hosting plan, writes needs, kicks off the agent and speaks the contract example", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const res = await env.call("handle_situation", { situation: GOLDEN });
    const body = assertEnvelope("handle_situation", res);

    expect(body.plan).toMatchObject({ kind: "hosting", title: "Dinner for 6, Friday 7 PM", household_id: HH, status: "active" });
    expect(body.plan.starts_at).toBe("2026-10-16T19:00:00-04:00");
    expect(body.plan.needs.map((n: { capability: string }) => n.capability)).toEqual(["messages", "calendar", "supplies", "services"]);
    expect(body.plan.needs.map((n: { status: string }) => n.status)).toEqual(["doing", "doing", "doing", "doing"]);
    expect(body.handled_by_butler).toBe(3);
    expect(body.needs_you).toBe(1);
    expect(body.spoken_summary).toBe(
      "Got it, six guests Friday at 7 PM. I'll handle invites, the calendar and drinks, and I'll check with you on cleaning.",
    );
    expect((res._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe("ui://butler/plan");

    // stored exactly as returned
    const stored = await env.repo.getPlan(HH, body.plan.plan_id);
    expect(stored).toEqual(body.plan);

    await env.settle();
    expect(env.agent.calls).toEqual([{ op: "start_plan", args: { planId: body.plan.plan_id, householdId: HH, correlationId: "cor_TEST" } }]);
  });

  it("does not wait for the agent (fire and forget)", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    env.agent.startPlan = async () => {
      await gate;
    };
    const started = Date.now();
    const res = await env.call("handle_situation", { situation: GOLDEN });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.isError).toBeUndefined();
    release();
    await env.settle();
  });

  it("accepts `when` and resolves it in the household timezone", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: "friends are coming over for dinner", when: "Friday at 7" }));
    expect(body.plan.starts_at).toBe("2026-10-16T19:00:00-04:00");
  });

  it("handles the away situation with a date range", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const body = assertEnvelope(
      "handle_situation",
      await env.call("handle_situation", { situation: "I'm travelling Thursday to Sunday. My parents are staying at the house." }),
    );
    expect(body.plan.kind).toBe("away");
    expect(body.plan.starts_at).toBe("2026-10-15T00:00:00-04:00");
    expect(body.plan.ends_at).toBe("2026-10-18T23:59:00-04:00");
    expect(body.spoken_summary).toContain("you're away Thursday to Sunday");
    expect(body.needs_you).toBe(0);
    expect(body.handled_by_butler).toBe(3);
  });

  it("returns the existing plan for an overlapping plan of the same kind (§3.2 MVP)", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const first = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    const second = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: "Actually four friends are coming Friday at 8" }));
    expect(second.plan.plan_id).toBe(first.plan.plan_id);
    expect(second.spoken_summary).toBe("You already have a plan for Friday. Here's where it stands.");
    await env.settle();
    expect(env.agent.calls.filter((c) => c.op === "start_plan")).toHaveLength(1);
    expect(await env.repo.listPlanHeaders(HH)).toHaveLength(1);
  });

  it("a different kind or a non-overlapping time is not a duplicate", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    await env.call("handle_situation", { situation: GOLDEN });
    const away = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: "I'm travelling Thursday to Sunday" }));
    const next = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: "friends are coming over for dinner next Friday at 7" }));
    expect(new Set([away.plan.plan_id, next.plan.plan_id]).size).toBe(2);
    expect(await env.repo.listPlanHeaders(HH)).toHaveLength(3);
  });

  it("completed plans don't count as duplicates", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const first = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    await env.repo.putPlan({ ...first.plan, status: "complete", needs: [] });
    const second = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    expect(second.plan.plan_id).not.toBe(first.plan.plan_id);
  });

  it("marks needs blocked when the agent can't be reached", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    env.agent.failStart = new ButlerError("UPSTREAM_UNAVAILABLE");
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    expect(body.plan.needs[0].status).toBe("doing"); // the response doesn't wait
    await env.settle();
    const stored = await env.repo.getPlan(HH, body.plan.plan_id);
    expect(stored?.needs.filter((n) => n.status === "blocked")).toHaveLength(4);
    expect(stored?.needs.find((n) => n.capability === "services")?.status).toBe("blocked");
    expect(env.logger.entries.some((e) => e.msg === "agent.start_plan.failed")).toBe(true);
  });

  it("falls back to keywords when the needs pass exceeds its budget (still within ~2.5 s)", async () => {
    const slow: NeedsPass = { run: () => new Promise(() => {}) };
    const env = await makeEnv({ seed: { plans: false, receipts: false }, needsPass: slow, budgetMs: 1100 });
    const started = Date.now();
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(body.plan.kind).toBe("hosting");
    expect(env.logger.entries.some((e) => e.msg === "needs_pass.budget_fallback")).toBe(true);
  });

  it("falls back when the needs pass throws", async () => {
    const broken: NeedsPass = { run: async () => { throw new Error("bedrock down"); } };
    const env = await makeEnv({ seed: { plans: false, receipts: false }, needsPass: broken });
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    expect(body.plan.kind).toBe("hosting");
  });

  it("rejects invalid input with an INVALID_INPUT envelope the model can learn from", async () => {
    const env = await makeEnv({ seed: false });
    for (const args of [{}, { situation: "hi" }, { situation: "x".repeat(401) }, { situation: 5 }, { situation: "six friends", when: 7 }]) {
      const body = expectError(await env.call("handle_situation", args), "handle_situation", "INVALID_INPUT");
      expect(body.error.details).toBeTruthy();
    }
  });

  it("works without a household record (default timezone)", async () => {
    const env = await makeEnv({ seed: false });
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: GOLDEN }));
    expect(body.plan.starts_at).toBe("2026-10-16T19:00:00-04:00");
  });

  it("unrelated situations still produce a valid plan", async () => {
    const env = await makeEnv({ seed: { plans: false, receipts: false } });
    const body = assertEnvelope("handle_situation", await env.call("handle_situation", { situation: "something odd is happening" }));
    expect(body.plan.kind).toBe("other");
    void fixtures; void NOW;
  });
});
