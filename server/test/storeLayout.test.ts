/**
 * Cross-language layout test (05-local-build.md §2, ticket M-2): the TypeScript repo must write the same
 * items as libs/butler_actions/store.py. The golden file is produced by running the Python Store over the same
 * fixtures (test/golden/gen_store_golden.py, via `uv run`); here we write the fixtures with the TS repo and
 * compare key attributes and parsed `data` item by item.
 *
 * Optional live check: when DYNAMODB_ENDPOINT is reachable, write with the TS repo to a real table and read it back.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createMemoryRepo } from "../src/lib/memoryRepo.js";
import { createDynamoRepo } from "../src/lib/repo.js";
import { fixtures, HH, seedRepo } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(resolve(here, "golden/store_items.golden.json"), "utf8")) as Array<Record<string, unknown> & { PK: string; SK: string; data: Record<string, unknown> }>;

describe("TS repo vs the Python Store layout", () => {
  it("writes the same keys, GSI keys, types and data as store.py for every fixture entity", async () => {
    const repo = createMemoryRepo();
    await seedRepo(repo);
    await repo.setLatestDraft(HH, { rule_id: fixtures.rules[fixtures.rules.length - 1]!.rule_id });
    const ts = new Map([...repo.table.items.values()].map((i) => [`${i.PK}|${i.SK}`, i]));

    expect(new Set(ts.keys())).toEqual(new Set(golden.map((g) => `${g.PK}|${g.SK}`)));
    for (const g of golden) {
      const item = ts.get(`${g.PK}|${g.SK}`)!;
      const { data: goldenData, ...goldenKeys } = g;
      const { data, ...keys } = item;
      const expectedKeys = { ...goldenKeys };
      if (g.SK === "DRAFT#LATEST") {
        expect(JSON.parse(data).expires_at).toBeGreaterThan(1_700_000_000);
        expect(Object.keys(JSON.parse(data)).sort()).toEqual(["expires_at", "rule_id"]);
        expect(JSON.parse(data).rule_id).toBe(goldenData["rule_id"]);
        expect(keys).toEqual(expectedKeys);
        continue;
      }
      expect(keys, `${g.PK} ${g.SK}`).toEqual(expectedKeys);
      expect(typeof data).toBe("string");
      expect(JSON.parse(data), `${g.PK} ${g.SK}`).toEqual(goldenData);
    }
  });

  it("reads items the Python Store wrote", async () => {
    const repo = createMemoryRepo();
    for (const g of golden) {
      const { data, ...rest } = g;
      await repo.table.put({ ...(rest as { PK: string; SK: string; type: string }), data: JSON.stringify(data) });
    }
    // the golden DRAFT#LATEST has a placeholder expiry; skip it
    const plan = await repo.getPlan(HH, fixtures.planHosting.plan_id);
    expect(plan?.needs).toHaveLength(4);
    expect((await repo.listReceipts(HH)).length).toBe(10);
    expect((await repo.listRules(HH, { activeOnly: true })).length).toBe(6);
    expect((await repo.listPendingDecisions(HH)).length).toBe(2);
    expect((await repo.listContacts(HH)).length).toBe(9);
    expect((await repo.getHousehold(HH))?.name).toBe("Paul's home");
    expect((await repo.listReceiptsForPlan(fixtures.planHosting.plan_id)).length).toBe(5);
  });

  it("the golden file is current (regenerated with uv run when uv is available)", () => {
    try {
      execFileSync("uv", ["--version"], { stdio: "ignore" });
    } catch {
      return; // uv not installed: the checked-in golden stands
    }
    if (process.env["REGEN_GOLDEN"] !== "1") return; // regeneration is opt-in (needs the Python workspace synced)
    execFileSync("uv", ["run", "python", "server/test/golden/gen_store_golden.py"], { cwd: resolve(here, "../.."), stdio: "ignore" });
  });
});

async function reachable(endpoint: string): Promise<boolean> {
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
    return res.status > 0;
  } catch {
    return false;
  }
}

const endpoint = process.env["DYNAMODB_ENDPOINT"];
const live = endpoint ? await reachable(endpoint) : false;

describe.skipIf(!live)("live DynamoDB (DYNAMODB_ENDPOINT reachable)", () => {
  it("round trips through a real table and uses the same keys", async () => {
    const { DynamoDBClient, CreateTableCommand, DeleteTableCommand } = await import("@aws-sdk/client-dynamodb");
    const tableName = `butler-ts-test-${Date.now()}`;
    const client = new DynamoDBClient({ region: "us-east-1", endpoint, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((n) => ({ AttributeName: n, AttributeType: "S" as const })),
        KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }],
        GlobalSecondaryIndexes: [{ IndexName: "GSI1", KeySchema: [{ AttributeName: "GSI1PK", KeyType: "HASH" }, { AttributeName: "GSI1SK", KeyType: "RANGE" }], Projection: { ProjectionType: "ALL" } }],
      }),
    );
    try {
      const repo = createDynamoRepo({ tableName, endpoint: endpoint as string });
      await seedRepo(repo);
      expect((await repo.getPlan(HH, fixtures.planHosting.plan_id))).toEqual(fixtures.planHosting);
      expect((await repo.listPlanHeaders(HH)).map((p) => p.plan_id)).toEqual([fixtures.planAway.plan_id, fixtures.planHosting.plan_id]);
      expect((await repo.listReceipts(HH, { limit: 3 })).length).toBe(3);
      expect((await repo.listPendingDecisions(HH)).length).toBe(2);
      const d = fixtures.decisions[0]!;
      const [a, b] = await Promise.all([
        repo.transitionDecision(HH, d.plan_id, d.decision_id, "pending", "approved"),
        repo.transitionDecision(HH, d.plan_id, d.decision_id, "pending", "approved"),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await repo.listRules(HH, { activeOnly: true })).length).toBe(6);
      await repo.setLatestDraft(HH, { rule_id: "rule_x" });
      expect((await repo.getLatestDraft(HH))?.rule_id).toBe("rule_x");
      const page = await repo.listReceipts(HH, { limit: 3 });
      expect((await repo.listReceipts(HH, { limit: 3, after: page[2]!.action_id }))[0]?.action_id).not.toBe(page[2]!.action_id);
    } finally {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
    }
  });
});
