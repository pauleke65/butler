import { describe, expect, it } from "vitest";
import type { Receipt } from "@butler/contracts";
import { assertEnvelope, expectError, fixtures, makeEnv, receiptByTitle } from "./helpers.js";

const readOnly = (base: Receipt, tool: Receipt["action"]["tool"], id: string, at: string, score = 0.9): Receipt => ({
  ...base,
  action_id: id,
  action: { tool, args: {} },
  title: `Searched ${id}`,
  created_at: at,
  might_disagree: { score },
});

describe("list_actions", () => {
  it("default: this week, all, newest first, capped at 5 with total_count", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("list_actions", await env.call("list_actions", {}));
    expect(body.period).toBe("this_week");
    expect(body.filter).toBe("all");
    expect(body.actions).toHaveLength(5);
    expect(body.total_count).toBe(8); // the two receipts from 10 and 24 days ago are outside this week
    const ids = body.actions.map((a: Receipt) => a.action_id);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(body.spoken_summary).toMatch(/^I took eight actions this week\./);
  });

  it("might_disagree ranks by score and only includes score >= 0.3 (BrightHome, then the 42 dollar drinks)", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("list_actions", await env.call("list_actions", { filter: "might_disagree" }));
    expect(body.actions.map((a: Receipt) => a.title)).toEqual(["Booked BrightHome", "Bought drinks for 7"]);
    expect(body.total_count).toBe(2);
    expect(body.spoken_summary).toBe("Two things might bother you, starting with: booked BrightHome. It's the first time I booked a cleaner.");
  });

  it("blocked includes held_for_approval and blocked", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("list_actions", await env.call("list_actions", { filter: "blocked" }));
    expect(body.actions.map((a: Receipt) => a.status).sort()).toEqual(["blocked", "held_for_approval"]);
  });

  it("purchases are executed checkouts and bookings", async () => {
    const env = await makeEnv();
    const body = assertEnvelope("list_actions", await env.call("list_actions", { filter: "purchases" }));
    expect(body.actions.map((a: Receipt) => a.title).sort()).toEqual(["Booked BrightHome", "Bought a snack platter", "Bought drinks for 7"]);
  });

  it("period=plan uses the given plan or the latest one", async () => {
    const env = await makeEnv();
    const hosting = assertEnvelope("list_actions", await env.call("list_actions", { period: "plan", plan_id: fixtures.planHosting.plan_id }));
    expect(hosting.total_count).toBe(5);
    const latest = assertEnvelope("list_actions", await env.call("list_actions", { period: "plan" }));
    expect(latest.actions.every((a: Receipt) => a.plan_id === fixtures.planAway.plan_id)).toBe(true);
    expectError(await env.call("list_actions", { period: "plan", plan_id: "plan_nope" }), "list_actions", "NOT_FOUND");
    const empty = await makeEnv({ seed: false });
    expectError(await empty.call("list_actions", { period: "plan" }), "list_actions", "NO_ACTIVE_PLAN");
  });

  it("period=today uses the household's local midnight", async () => {
    const env = await makeEnv();
    expect(assertEnvelope("list_actions", await env.call("list_actions", { period: "today" })).total_count).toBe(8);
    env.clock.set(new Date("2026-10-15T14:00:00Z"));
    const next = assertEnvelope("list_actions", await env.call("list_actions", { period: "today" }));
    expect(next.total_count).toBe(0);
    expect(next.spoken_summary).toBe("I haven't done anything today yet.");
  });

  it("empty results speak sensibly for every filter", async () => {
    const env = await makeEnv({ seed: false });
    for (const filter of ["all", "purchases", "might_disagree", "blocked"]) {
      const body = assertEnvelope("list_actions", await env.call("list_actions", { filter }));
      expect(body.actions).toEqual([]);
    }
  });

  it("excludes read-only tool receipts (searches, listings, weather) from actions, filters and ranking", async () => {
    const env = await makeEnv();
    const base = receiptByTitle("Bought drinks for 7");
    const at = "2026-10-14T18:50:00+00:00";
    const noise: Receipt[] = [
      readOnly(base, "Supplies___search_products", "act_zzz1", at),
      readOnly(base, "Services___search_providers", "act_zzz2", at),
      readOnly(base, "Calendar___list_events", "act_zzz3", at),
      readOnly(base, "Context___get_weather", "act_zzz4", at),
    ];
    for (const r of noise) await env.repo.putReceipt(r);
    for (const filter of ["all", "might_disagree", "purchases", "blocked"]) {
      const body = assertEnvelope("list_actions", await env.call("list_actions", { filter }));
      expect(body.actions.some((a: Receipt) => a.title.startsWith("Searched"))).toBe(false);
    }
    expect(assertEnvelope("list_actions", await env.call("list_actions", {})).total_count).toBe(8);
    const plan = assertEnvelope("list_actions", await env.call("list_actions", { period: "plan", plan_id: fixtures.planHosting.plan_id }));
    expect(plan.total_count).toBe(5);
    const ledger = assertEnvelope("get_ledger_page", await env.call("get_ledger_page", { limit: 20 }));
    expect(ledger.actions.some((a: Receipt) => a.title.startsWith("Searched"))).toBe(false);
    // "that" never resolves to a search
    const explained = assertEnvelope("explain_action", await env.call("explain_action", { reference: "that" }));
    expect(explained.receipt.title.startsWith("Searched")).toBe(false);
  });

  it("invalid input", async () => {
    const env = await makeEnv();
    expectError(await env.call("list_actions", { period: "forever" }), "list_actions", "INVALID_INPUT");
    expectError(await env.call("list_actions", { filter: "weird" }), "list_actions", "INVALID_INPUT");
  });
});

describe("get_ledger_page (app-only)", () => {
  it("pages newest first with a stable cursor and no duplicates", async () => {
    const env = await makeEnv();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const body = assertEnvelope("get_ledger_page", await env.call("get_ledger_page", { limit: 3, ...(cursor ? { cursor } : {}) }));
      seen.push(...body.actions.map((a: Receipt) => a.action_id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("filters while paging", async () => {
    const env = await makeEnv();
    const p1 = assertEnvelope("get_ledger_page", await env.call("get_ledger_page", { filter: "blocked", limit: 1 }));
    expect(p1.actions).toHaveLength(1);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = assertEnvelope("get_ledger_page", await env.call("get_ledger_page", { filter: "blocked", limit: 1, cursor: p1.next_cursor }));
    expect(p2.actions).toHaveLength(1);
    expect(p2.next_cursor).toBeUndefined();
    expect(p2.actions[0].action_id).not.toBe(p1.actions[0].action_id);
  });

  it("validates input", async () => {
    const env = await makeEnv();
    expectError(await env.call("get_ledger_page", { limit: 0 }), "get_ledger_page", "INVALID_INPUT");
    expectError(await env.call("get_ledger_page", { limit: 21 }), "get_ledger_page", "INVALID_INPUT");
    expectError(await env.call("get_ledger_page", { filter: "nope" }), "get_ledger_page", "INVALID_INPUT");
    expectError(await env.call("get_ledger_page", { cursor: "!!!" }), "get_ledger_page", "INVALID_INPUT");
    const empty = await makeEnv({ seed: false });
    const body = assertEnvelope("get_ledger_page", await empty.call("get_ledger_page", {}));
    expect(body.actions).toEqual([]);
  });
});

describe("explain_action", () => {
  const sceneFour = async () => {
    const env = await makeEnv({ seed: { receipts: false } });
    for (const r of fixtures.receipts.filter((x) => x.plan_id !== fixtures.planAway.plan_id)) await env.repo.putReceipt(r);
    return env;
  };

  it("explains by id", async () => {
    const env = await makeEnv();
    const drinks = receiptByTitle("Bought drinks for 7");
    const body = assertEnvelope("explain_action", await env.call("explain_action", { action_id: drinks.action_id }));
    expect(body.receipt.alternatives.map((a: { option: string }) => a.option)).toEqual(["BudgetBasket, 36 dollars", "Corner Cellar, 58 dollars"]);
    expect(body.spoken_summary).toBe("I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it.");
  });

  it("'the drinks' resolves to the purchase at demo scene 4 and 'that' to the latest", async () => {
    const env = await sceneFour();
    const body = assertEnvelope("explain_action", await env.call("explain_action", { reference: "Why did you buy the drinks?" }));
    expect(body.receipt.title).toBe("Bought drinks for 7");
    const that = assertEnvelope("explain_action", await env.call("explain_action", { reference: "that" }));
    expect(that.receipt.title).toBe("Booked BrightHome");
  });

  it("'the email to Tolu' resolves to the invite", async () => {
    const env = await sceneFour();
    const body = assertEnvelope("explain_action", await env.call("explain_action", { reference: "the email to Tolu" }));
    expect(body.receipt.title).toBe("Invited 6 guests");
  });

  it("ambiguity returns up to 3 candidates", async () => {
    const env = await makeEnv();
    const body = expectError(await env.call("explain_action", { reference: "the drinks" }), "explain_action", "AMBIGUOUS_REFERENCE");
    expect(body.error.candidates.length).toBeGreaterThanOrEqual(2);
    expect(body.error.candidates.length).toBeLessThanOrEqual(3);
    expect(body.error.message_spoken).toMatch(/^Did you mean .* or .*\?$/);
  });

  it("not found, invalid and cross-household", async () => {
    const env = await makeEnv();
    expectError(await env.call("explain_action", { action_id: "act_nope" }), "explain_action", "NOT_FOUND");
    expectError(await env.call("explain_action", { reference: "the helicopter" }), "explain_action", "NOT_FOUND");
    expectError(await env.call("explain_action", {}), "explain_action", "INVALID_INPUT");
    expectError(await env.call("explain_action", { action_id: 3 }), "explain_action", "INVALID_INPUT");
    const other = await makeEnv({ seed: false });
    await other.repo.putReceipt({ ...fixtures.receipts[0]!, household_id: "hh_other" });
    expectError(await other.call("explain_action", { action_id: fixtures.receipts[0]!.action_id }), "explain_action", "NOT_FOUND");
  });

  it("falls back to a composed summary when a receipt's own spoken text breaks the style rules", async () => {
    const env = await makeEnv();
    const bad = { ...fixtures.receipts[0]!, action_id: "act_bad", spoken_summary: "I paid $42.50!! See https://x.com", created_at: "2026-10-14T18:59:00+00:00" };
    await env.repo.putReceipt(bad);
    const body = assertEnvelope("explain_action", await env.call("explain_action", { action_id: "act_bad" }));
    expect(body.spoken_summary).toBe("Invited 6 guests because six friends from the dinner crew are coming Friday.");
  });
});
