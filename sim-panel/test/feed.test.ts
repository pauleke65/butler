import { describe, expect, it } from "vitest";
import { ReceiptStore, RuleStore, formatAmount, splitTool, toRow } from "../src/feed";
import type { DebugReceipt, DebugRule } from "../src/types";
import { makeReceipt } from "../mock/debug-api.mjs";

const rcp = (o: Record<string, unknown> = {}) => makeReceipt(o) as unknown as DebugReceipt;

describe("formatting", () => {
  it("formats minor units, never floats", () => {
    expect(formatAmount(4200)).toBe("$42.00");
    expect(formatAmount(3100, "USD")).toBe("$31.00");
    expect(formatAmount(5)).toBe("$0.05");
    expect(formatAmount(undefined)).toBeUndefined();
  });
  it("splits gateway tool names", () => {
    expect(splitTool("Supplies___checkout")).toEqual({ target: "Supplies", tool: "checkout" });
    expect(splitTool("plain")).toEqual({ target: "", tool: "plain" });
  });
});

describe("toRow", () => {
  it("shows tool, principal, decision, rule text and amount", () => {
    const row = toRow(rcp({ amount_minor: 4200, rule_ids: ["rule_default_spend"], rule_texts: ["Ask me before spending more than 50 dollars."] }), false);
    expect(row).toMatchObject({ target: "Supplies", tool: "checkout", principal: "butler-agent", decision: "ALLOW", amount: "$42.00", ruleText: "Ask me before spending more than 50 dollars." });
  });
  it("marks DENY and falls back to the amount in the action args", () => {
    const row = toRow(rcp({ decision: "DENY", args: { amount_minor: 3100 }, rule_texts: ["Ask me before buying drinks."] }), true);
    expect(row).toMatchObject({ decision: "DENY", amount: "$31.00", fresh: true, statusNote: "held for approval" });
  });
});

describe("ReceiptStore", () => {
  it("only flags receipts arriving after the first load as fresh and sorts newest first", () => {
    const s = new ReceiptStore();
    const a = rcp({ at: 1_000_000 });
    const b = rcp({ at: 2_000_000 });
    s.merge([a, b]);
    expect(s.rows().every((r) => !r.fresh)).toBe(true);
    const c = rcp({ at: 3_000_000, decision: "DENY" });
    expect(s.merge([b, c])).toEqual([c.action_id]);
    const rows = s.rows();
    expect(rows[0]!.id).toBe(c.action_id);
    expect(rows[0]!.fresh).toBe(true);
    expect(s.lastActionId).toBe(c.action_id);
    expect(s.size).toBe(3);
  });
});

describe("RuleStore", () => {
  const rule = (id: string, active = true, extra: Partial<DebugRule> = {}): DebugRule => ({ rule_id: id, text: id, effect: "ask_first", policy_status: active ? "active" : "creating", active, created_at: "2026-01-01T00:00:00Z", ...extra });
  it("highlights rules that appear or activate after the first poll, then fades", () => {
    const s = new RuleStore(10_000);
    s.update([rule("a")], 1000);
    expect(s.rows(1001).every((r) => !r.isNew)).toBe(true);
    s.update([rule("a"), rule("b", false, { created_at: "2026-02-01T00:00:00Z" })], 5000);
    expect(s.rows(5001).find((r) => r.id === "b")).toMatchObject({ isNew: true, active: false });
    s.update([rule("a"), rule("b", true)], 6000);
    expect(s.rows(6001).find((r) => r.id === "b")).toMatchObject({ isNew: true, active: true });
    expect(s.rows(6001)[0]!.id).toBe("b"); // active + newest first
    expect(s.rows(30_000).find((r) => r.id === "b")!.isNew).toBe(false);
    expect(s.activeCount).toBe(2);
  });
});
