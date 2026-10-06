import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepo } from "../src/lib/memoryRepo.js";
import { cleaningDecision, drinksDecision, fixtures, HH, seedRepo } from "./helpers.js";

let nowSeconds = 1_800_000_000;
let repo: ReturnType<typeof createMemoryRepo>;

beforeEach(async () => {
  nowSeconds = 1_800_000_000;
  repo = createMemoryRepo({ nowSeconds: () => nowSeconds });
  await seedRepo(repo);
});

describe("TableRepo key layout (mirrors store.py)", () => {
  it("writes items as {PK, SK, GSI1PK, GSI1SK, type, data(JSON string)}", () => {
    const items = [...repo.table.items.values()];
    const plan = items.find((i) => i.SK === `PLAN#${fixtures.planHosting.plan_id}`);
    expect(plan).toMatchObject({
      PK: `HH#${HH}`,
      GSI1PK: `HH#${HH}#PLANS`,
      GSI1SK: fixtures.planHosting.updated_at,
      type: "plan",
    });
    expect(typeof plan?.data).toBe("string");
    expect(JSON.parse(plan?.data as string).needs).toEqual([]); // needs are separate items

    const need = items.find((i) => i.PK === `PLAN#${fixtures.planHosting.plan_id}` && i.SK.startsWith("NEED#"));
    expect(need?.type).toBe("need");

    const dec = items.find((i) => i.SK === `DEC#${cleaningDecision().decision_id}`);
    expect(dec).toMatchObject({ PK: `PLAN#${fixtures.planHosting.plan_id}`, GSI1PK: `HH#${HH}#DEC#pending`, type: "decision", household_id: HH });

    const receipt = fixtures.receipts[0]!;
    expect(items.find((i) => i.SK === `ACT#${receipt.action_id}`)).toMatchObject({
      PK: `HH#${HH}`,
      GSI1PK: `PLAN#${receipt.plan_id}#ACT`,
      GSI1SK: receipt.action_id,
      type: "receipt",
    });
    const noPlan = fixtures.receipts.find((r) => !r.plan_id)!;
    expect(items.find((i) => i.SK === `ACT#${noPlan.action_id}`)?.GSI1PK).toBe(`HH#${HH}#NOPLAN#ACT`);

    expect(items.find((i) => i.SK === "RULE#rule_default_spend")).toMatchObject({ GSI1PK: `HH#${HH}#RULES#true`, type: "rule" });
    expect(items.find((i) => i.SK === "META")).toMatchObject({ PK: `HH#${HH}`, type: "household" });
    expect(items.find((i) => i.SK === "CONTACT#c_tolu")?.type).toBe("contact");
  });
});

describe("plans and needs", () => {
  it("round trips a plan with needs, sorted by need id", async () => {
    const plan = await repo.getPlan(HH, fixtures.planHosting.plan_id);
    expect(plan).toEqual(fixtures.planHosting);
    expect(plan?.needs.map((n) => n.need_id)).toEqual([...fixtures.planHosting.needs.map((n) => n.need_id)].sort());
  });

  it("lists plan headers newest-updated first and touchPlan re-sorts", async () => {
    let headers = await repo.listPlanHeaders(HH);
    expect(headers.map((p) => p.plan_id)).toEqual([fixtures.planAway.plan_id, fixtures.planHosting.plan_id]);
    await repo.touchPlan(HH, fixtures.planHosting.plan_id, "2026-10-15T00:00:00+00:00");
    headers = await repo.listPlanHeaders(HH);
    expect(headers[0]?.plan_id).toBe(fixtures.planHosting.plan_id);
    // touching with an older time is a no-op
    await repo.touchPlan(HH, fixtures.planHosting.plan_id, "2026-01-01T00:00:00+00:00");
    expect((await repo.getPlan(HH, fixtures.planHosting.plan_id))?.updated_at).toBe("2026-10-15T00:00:00+00:00");
  });

  it("setPlanLastRead stamps without bumping updated_at", async () => {
    await repo.setPlanLastRead(HH, fixtures.planHosting.plan_id, "2026-10-14T19:00:00+00:00");
    const p = await repo.getPlan(HH, fixtures.planHosting.plan_id);
    expect(p?.last_status_read_at).toBe("2026-10-14T19:00:00+00:00");
    expect(p?.updated_at).toBe(fixtures.planHosting.updated_at);
  });

  it("returns null for unknown plans", async () => {
    expect(await repo.getPlan(HH, "plan_nope")).toBeNull();
    expect(await repo.getPlan("hh_other", fixtures.planHosting.plan_id)).toBeNull();
  });
});

describe("decisions", () => {
  it("lists pending decisions through GSI1 and finds one by id across plans", async () => {
    const pending = await repo.listPendingDecisions(HH);
    expect(pending.map((d) => d.decision_id).sort()).toEqual(fixtures.decisions.map((d) => d.decision_id).sort());
    expect((await repo.findDecision(HH, drinksDecision().decision_id))?.kind).toBe("approve_action");
    expect(await repo.findDecision(HH, "dec_missing")).toBeNull();
  });

  it("transitionDecision is atomic: only the first mover wins and the GSI follows the status", async () => {
    const d = cleaningDecision();
    const [a, b] = await Promise.all([
      repo.transitionDecision(HH, d.plan_id, d.decision_id, "pending", "approved", { chosen_option_id: d.options[1]!.option_id }),
      repo.transitionDecision(HH, d.plan_id, d.decision_id, "pending", "approved", { chosen_option_id: d.options[2]!.option_id }),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect((await repo.listPendingDecisions(HH)).map((x) => x.decision_id)).not.toContain(d.decision_id);
    const stored = await repo.getDecision(d.plan_id, d.decision_id);
    expect(stored?.status).toBe("approved");
    expect(await repo.transitionDecision(HH, d.plan_id, d.decision_id, "pending", "rejected")).toBeNull();
    expect(await repo.transitionDecision(HH, d.plan_id, "dec_nope", "pending", "rejected")).toBeNull();
  });
});

describe("receipts", () => {
  it("lists newest first and pages with an exclusive cursor", async () => {
    const all = await repo.listReceipts(HH);
    expect(all).toHaveLength(10);
    const ids = all.map((r) => r.action_id);
    expect(ids).toEqual([...ids].sort().reverse());
    const page1 = await repo.listReceipts(HH, { limit: 4 });
    const page2 = await repo.listReceipts(HH, { limit: 4, after: page1[3]!.action_id });
    expect([...page1, ...page2].map((r) => r.action_id)).toEqual(ids.slice(0, 8));
    const oldest = await repo.listReceipts(HH, { newestFirst: false, limit: 2 });
    expect(oldest[0]?.action_id).toBe(ids[ids.length - 1]);
  });

  it("lists receipts for a plan via GSI1", async () => {
    const forPlan = await repo.listReceiptsForPlan(fixtures.planHosting.plan_id);
    expect(forPlan.length).toBe(fixtures.receipts.filter((r) => r.plan_id === fixtures.planHosting.plan_id).length);
    expect(await repo.getReceipt(HH, fixtures.receipts[0]!.action_id)).toEqual(fixtures.receipts[0]);
  });
});

describe("rules and the draft lock", () => {
  it("lists active rules via GSI1 and moves a rule out when it is deactivated", async () => {
    expect(await repo.listRules(HH, { activeOnly: true })).toHaveLength(6);
    const r = fixtures.rules[5]!;
    await repo.putRule({ ...r, active: false, policy_status: "disabled" });
    expect(await repo.listRules(HH, { activeOnly: true })).toHaveLength(5);
    expect(await repo.listRules(HH)).toHaveLength(6);
  });

  it("DRAFT#LATEST expires after 10 minutes and carries additive fields", async () => {
    expect(await repo.getLatestDraft(HH)).toBeNull();
    await repo.setLatestDraft(HH, { rule_id: "rule_x", intent: "replace", replaces_rule_id: "rule_y" });
    expect(await repo.getLatestDraft(HH)).toMatchObject({ rule_id: "rule_x", intent: "replace", replaces_rule_id: "rule_y", expires_at: nowSeconds + 600 });
    nowSeconds += 599;
    expect(await repo.getLatestDraft(HH)).not.toBeNull();
    nowSeconds += 2;
    expect(await repo.getLatestDraft(HH)).toBeNull();
    // stored in the layout store.py reads: data = {"rule_id", "expires_at"}
    const raw = repo.table.items.get(`HH#${HH}\u0000DRAFT#LATEST`);
    expect(raw?.type).toBe("draft_lock");
    expect(JSON.parse(raw!.data)).toHaveProperty("rule_id", "rule_x");
  });
});

describe("household and contacts", () => {
  it("reads the household and contacts", async () => {
    expect((await repo.getHousehold(HH))?.timezone).toBe("America/New_York");
    expect((await repo.listContacts(HH)).map((c) => c.contact_id)).toContain("c_tolu");
    expect(await repo.getHousehold("hh_nope")).toBeNull();
  });
});
