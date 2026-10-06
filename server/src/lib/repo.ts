/**
 * Data access layer (contracts §10, ticket M-2).
 *
 * `TableRepo` implements the `Repo` interface over a tiny `Table` abstraction. The key layout mirrors
 * libs/butler_actions/butler_actions/store.py EXACTLY: every item is
 * `{PK, SK, [GSI1PK, GSI1SK], type, data(JSON string), [ttl]}`.
 * `DynamoTable` talks to DynamoDB (lib-dynamodb); `MemoryTable` (memoryRepo.ts) is an in-memory fake with the
 * same semantics, so tests exercise the exact same key logic.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  Contact as ContactSchema,
  Decision as DecisionSchema,
  Household as HouseholdSchema,
  Need as NeedSchema,
  Plan as PlanSchema,
  Receipt as ReceiptSchema,
  Rule as RuleSchema,
  type Contact,
  type Decision,
  type Household,
  type Need,
  type Plan,
  type Receipt,
  type Rule,
} from "@butler/contracts";
import type { z } from "zod";

// ───────────────────────────── repo interface ─────────────────────────────

export interface DraftLock {
  rule_id: string;
  /** Epoch seconds (store.py compares against time.time()). */
  expires_at: number;
  /** Additive fields (ignored by the Python reader). */
  intent?: "new" | "replace" | "remove";
  replaces_rule_id?: string;
}

export interface ReceiptQuery {
  newestFirst?: boolean;
  limit?: number;
  /** Exclusive cursor: continue after this action_id in the iteration direction. */
  after?: string;
}

export interface Repo {
  getHousehold(householdId: string): Promise<Household | null>;
  putHousehold(household: Household): Promise<void>;
  putContact(householdId: string, contact: Contact): Promise<void>;
  listContacts(householdId: string): Promise<Contact[]>;

  putPlan(plan: Plan): Promise<void>;
  putNeed(need: Need): Promise<void>;
  getPlan(householdId: string, planId: string): Promise<Plan | null>;
  /** Plan headers (needs: []) newest-updated first. */
  listPlanHeaders(householdId: string, limit?: number): Promise<Plan[]>;
  listPlans(householdId: string, limit?: number): Promise<Plan[]>;
  listNeeds(planId: string): Promise<Need[]>;
  /** Stamp `last_status_read_at` without bumping `updated_at`. */
  setPlanLastRead(householdId: string, planId: string, iso: string): Promise<void>;
  /** Bump `updated_at` (and the GSI sort key) after a need/decision change so recency ordering works. */
  touchPlan(householdId: string, planId: string, updatedAtIso: string): Promise<void>;

  putDecision(householdId: string, decision: Decision): Promise<void>;
  getDecision(planId: string, decisionId: string): Promise<Decision | null>;
  findDecision(householdId: string, decisionId: string): Promise<Decision | null>;
  listDecisions(planId: string): Promise<Decision[]>;
  listPendingDecisions(householdId: string): Promise<Decision[]>;
  /** Atomic status move; null if the current status wasn't `from`. */
  transitionDecision(
    householdId: string,
    planId: string,
    decisionId: string,
    from: Decision["status"],
    to: Decision["status"],
    updates?: Partial<Decision>,
  ): Promise<Decision | null>;

  putReceipt(receipt: Receipt): Promise<void>;
  getReceipt(householdId: string, actionId: string): Promise<Receipt | null>;
  listReceipts(householdId: string, q?: ReceiptQuery): Promise<Receipt[]>;
  listReceiptsForPlan(planId: string): Promise<Receipt[]>;

  putRule(rule: Rule): Promise<void>;
  getRule(householdId: string, ruleId: string): Promise<Rule | null>;
  listRules(householdId: string, opts?: { activeOnly?: boolean }): Promise<Rule[]>;

  setLatestDraft(householdId: string, lock: Omit<DraftLock, "expires_at">, ttlSeconds?: number): Promise<void>;
  getLatestDraft(householdId: string): Promise<DraftLock | null>;
}

// ───────────────────────────── table abstraction ─────────────────────────────

export interface Item {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  type: string;
  data: string;
  ttl?: number;
  [extra: string]: unknown;
}

export interface QuerySpec {
  pk: string;
  skPrefix?: string;
  index?: "GSI1";
  forward?: boolean;
  limit?: number;
  /** Exclusive start (base table only): sort key to continue after. */
  startAfterSk?: string;
}

export interface Table {
  put(item: Item, cond?: { ifNotExists?: boolean; ifDataEquals?: string }): Promise<boolean>;
  get(pk: string, sk: string): Promise<Item | undefined>;
  query(q: QuerySpec): Promise<Item[]>;
  delete(pk: string, sk: string): Promise<void>;
}

// ───────────────────────────── DynamoDB table ─────────────────────────────

export interface DynamoTableConfig {
  tableName: string;
  region?: string;
  /** When set (local moto/DynamoDB Local), explicit dummy credentials are used. */
  endpoint?: string;
  client?: DynamoDBDocumentClient;
}

export class DynamoTable implements Table {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(cfg: DynamoTableConfig) {
    this.tableName = cfg.tableName;
    this.doc =
      cfg.client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region: cfg.region ?? "us-east-1",
          ...(cfg.endpoint ? { endpoint: cfg.endpoint, credentials: { accessKeyId: "test", secretAccessKey: "test" } } : {}),
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  async put(item: Item, cond: { ifNotExists?: boolean; ifDataEquals?: string } = {}): Promise<boolean> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ...(cond.ifNotExists ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
          ...(cond.ifDataEquals !== undefined
            ? {
                ConditionExpression: "#d = :old",
                ExpressionAttributeNames: { "#d": "data" },
                ExpressionAttributeValues: { ":old": cond.ifDataEquals },
              }
            : {}),
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof ConditionalCheckFailedException || (e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }

  async get(pk: string, sk: string): Promise<Item | undefined> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk }, ConsistentRead: true }));
    return res.Item as Item | undefined;
  }

  async query(q: QuerySpec): Promise<Item[]> {
    const pkName = q.index ? "GSI1PK" : "PK";
    const skName = q.index ? "GSI1SK" : "SK";
    const names: Record<string, string> = { "#pk": pkName };
    const values: Record<string, unknown> = { ":pk": q.pk };
    let cond = "#pk = :pk";
    if (q.skPrefix !== undefined) {
      names["#sk"] = skName;
      values[":sk"] = q.skPrefix;
      cond += " AND begins_with(#sk, :sk)";
    }
    const out: Item[] = [];
    let startKey: Record<string, unknown> | undefined = q.startAfterSk !== undefined && !q.index ? { PK: q.pk, SK: q.startAfterSk } : undefined;
    for (;;) {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          ...(q.index ? { IndexName: q.index } : {}),
          KeyConditionExpression: cond,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ScanIndexForward: q.forward ?? true,
          ...(q.limit ? { Limit: q.limit } : {}),
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      out.push(...((res.Items ?? []) as Item[]));
      if (q.limit && out.length >= q.limit) return out.slice(0, q.limit);
      if (!res.LastEvaluatedKey) return out;
      startKey = res.LastEvaluatedKey;
    }
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tableName, Key: { PK: pk, SK: sk } }));
  }
}

// ───────────────────────────── repository over a table ─────────────────────────────

function dump(value: unknown): string {
  return JSON.stringify(value);
}

function parse<S extends z.ZodType>(schema: S, item: Item | undefined): z.infer<S> | null {
  if (!item) return null;
  return schema.parse(JSON.parse(item.data)) as z.infer<S>;
}

export interface TableRepoOptions {
  /** Epoch seconds; defaults to wall clock (the Python store uses time.time() for the draft lock). */
  nowSeconds?: () => number;
}

export class TableRepo implements Repo {
  private readonly nowSeconds: () => number;

  constructor(
    readonly table: Table,
    opts: TableRepoOptions = {},
  ) {
    this.nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  // household / contacts
  async getHousehold(householdId: string): Promise<Household | null> {
    const item = await this.table.get(`HH#${householdId}`, "META");
    if (!item) return null;
    return HouseholdSchema.parse(JSON.parse(item.data));
  }

  // Seeding helpers (production data is loaded by the Python seed loader; kept for tests and the integration test).
  async putHousehold(hh: Household): Promise<void> {
    await this.table.put({ PK: `HH#${hh.household_id}`, SK: "META", type: "household", data: dump(hh) });
  }

  async putContact(householdId: string, contact: Contact): Promise<void> {
    await this.table.put({ PK: `HH#${householdId}`, SK: `CONTACT#${contact.contact_id}`, type: "contact", data: dump(contact) });
  }

  async listContacts(householdId: string): Promise<Contact[]> {
    const items = await this.table.query({ pk: `HH#${householdId}`, skPrefix: "CONTACT#" });
    return items.map((i) => ContactSchema.parse(JSON.parse(i.data)));
  }

  // plans and needs
  async putPlan(plan: Plan): Promise<void> {
    const header: Plan = { ...plan, needs: [] };
    await this.table.put({
      PK: `HH#${plan.household_id}`,
      SK: `PLAN#${plan.plan_id}`,
      GSI1PK: `HH#${plan.household_id}#PLANS`,
      GSI1SK: plan.updated_at,
      type: "plan",
      data: dump(header),
    });
    for (const n of plan.needs) await this.putNeed(n);
  }

  async putNeed(need: Need): Promise<void> {
    await this.table.put({ PK: `PLAN#${need.plan_id}`, SK: `NEED#${need.need_id}`, type: "need", data: dump(need) });
  }

  async listNeeds(planId: string): Promise<Need[]> {
    const items = await this.table.query({ pk: `PLAN#${planId}`, skPrefix: "NEED#" });
    return items.map((i) => NeedSchema.parse(JSON.parse(i.data))).sort((a, b) => (a.need_id < b.need_id ? -1 : a.need_id > b.need_id ? 1 : 0));
  }

  async getPlan(householdId: string, planId: string): Promise<Plan | null> {
    const plan = parse(PlanSchema, await this.table.get(`HH#${householdId}`, `PLAN#${planId}`));
    if (!plan) return null;
    return { ...plan, needs: await this.listNeeds(planId) };
  }

  async listPlanHeaders(householdId: string, limit = 20): Promise<Plan[]> {
    const items = await this.table.query({ pk: `HH#${householdId}#PLANS`, index: "GSI1", forward: false, limit });
    return items.map((i) => PlanSchema.parse(JSON.parse(i.data)));
  }

  async listPlans(householdId: string, limit = 20): Promise<Plan[]> {
    const headers = await this.listPlanHeaders(householdId, limit);
    return Promise.all(headers.map(async (p) => ({ ...p, needs: await this.listNeeds(p.plan_id) })));
  }

  async setPlanLastRead(householdId: string, planId: string, iso: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = await this.table.get(`HH#${householdId}`, `PLAN#${planId}`);
      if (!item) return;
      const plan = PlanSchema.parse(JSON.parse(item.data));
      const next = { ...item, data: dump({ ...plan, last_status_read_at: iso }) };
      if (await this.table.put(next, { ifDataEquals: item.data })) return;
    }
  }

  async touchPlan(householdId: string, planId: string, updatedAtIso: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = await this.table.get(`HH#${householdId}`, `PLAN#${planId}`);
      if (!item) return;
      const plan = PlanSchema.parse(JSON.parse(item.data));
      if (plan.updated_at >= updatedAtIso) return;
      const next = { ...item, GSI1SK: updatedAtIso, data: dump({ ...plan, updated_at: updatedAtIso }) };
      if (await this.table.put(next, { ifDataEquals: item.data })) return;
    }
  }

  // decisions
  async putDecision(householdId: string, d: Decision): Promise<void> {
    await this.table.put({
      PK: `PLAN#${d.plan_id}`,
      SK: `DEC#${d.decision_id}`,
      GSI1PK: `HH#${householdId}#DEC#${d.status}`,
      GSI1SK: d.created_at,
      type: "decision",
      data: dump(d),
      household_id: householdId,
    });
  }

  async getDecision(planId: string, decisionId: string): Promise<Decision | null> {
    return parse(DecisionSchema, await this.table.get(`PLAN#${planId}`, `DEC#${decisionId}`));
  }

  async findDecision(householdId: string, decisionId: string): Promise<Decision | null> {
    for (const plan of await this.listPlanHeaders(householdId, 50)) {
      const d = await this.getDecision(plan.plan_id, decisionId);
      if (d) return d;
    }
    return null;
  }

  async listDecisions(planId: string): Promise<Decision[]> {
    const items = await this.table.query({ pk: `PLAN#${planId}`, skPrefix: "DEC#" });
    return items.map((i) => DecisionSchema.parse(JSON.parse(i.data)));
  }

  async listPendingDecisions(householdId: string): Promise<Decision[]> {
    const items = await this.table.query({ pk: `HH#${householdId}#DEC#pending`, index: "GSI1" });
    return items.map((i) => DecisionSchema.parse(JSON.parse(i.data)));
  }

  async transitionDecision(
    householdId: string,
    planId: string,
    decisionId: string,
    from: Decision["status"],
    to: Decision["status"],
    updates: Partial<Decision> = {},
  ): Promise<Decision | null> {
    const current = await this.table.get(`PLAN#${planId}`, `DEC#${decisionId}`);
    if (!current) return null;
    const dec = DecisionSchema.parse(JSON.parse(current.data));
    if (dec.status !== from) return null;
    const next: Decision = { ...dec, ...updates, status: to };
    const ok = await this.table.put(
      { ...current, data: dump(next), GSI1PK: `HH#${householdId}#DEC#${to}` },
      { ifDataEquals: current.data },
    );
    return ok ? next : null;
  }

  // receipts
  async putReceipt(r: Receipt): Promise<void> {
    await this.table.put({
      PK: `HH#${r.household_id}`,
      SK: `ACT#${r.action_id}`,
      GSI1PK: r.plan_id ? `PLAN#${r.plan_id}#ACT` : `HH#${r.household_id}#NOPLAN#ACT`,
      GSI1SK: r.action_id,
      type: "receipt",
      data: dump(r),
    });
  }

  async getReceipt(householdId: string, actionId: string): Promise<Receipt | null> {
    return parse(ReceiptSchema, await this.table.get(`HH#${householdId}`, `ACT#${actionId}`));
  }

  async listReceipts(householdId: string, q: ReceiptQuery = {}): Promise<Receipt[]> {
    const items = await this.table.query({
      pk: `HH#${householdId}`,
      skPrefix: "ACT#",
      forward: !(q.newestFirst ?? true),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.after ? { startAfterSk: `ACT#${q.after}` } : {}),
    });
    return items.map((i) => ReceiptSchema.parse(JSON.parse(i.data)));
  }

  async listReceiptsForPlan(planId: string): Promise<Receipt[]> {
    const items = await this.table.query({ pk: `PLAN#${planId}#ACT`, index: "GSI1" });
    return items.map((i) => ReceiptSchema.parse(JSON.parse(i.data)));
  }

  // rules
  async putRule(rule: Rule): Promise<void> {
    await this.table.put({
      PK: `HH#${rule.household_id}`,
      SK: `RULE#${rule.rule_id}`,
      GSI1PK: `HH#${rule.household_id}#RULES#${String(rule.active).toLowerCase()}`,
      GSI1SK: rule.created_at,
      type: "rule",
      data: dump(rule),
    });
  }

  async getRule(householdId: string, ruleId: string): Promise<Rule | null> {
    return parse(RuleSchema, await this.table.get(`HH#${householdId}`, `RULE#${ruleId}`));
  }

  async listRules(householdId: string, opts: { activeOnly?: boolean } = {}): Promise<Rule[]> {
    const items = opts.activeOnly
      ? await this.table.query({ pk: `HH#${householdId}#RULES#true`, index: "GSI1" })
      : await this.table.query({ pk: `HH#${householdId}`, skPrefix: "RULE#" });
    return items.map((i) => RuleSchema.parse(JSON.parse(i.data)));
  }

  // draft lock
  async setLatestDraft(householdId: string, lock: Omit<DraftLock, "expires_at">, ttlSeconds = 600): Promise<void> {
    const data: DraftLock = { ...lock, expires_at: this.nowSeconds() + ttlSeconds };
    await this.table.put({ PK: `HH#${householdId}`, SK: "DRAFT#LATEST", type: "draft_lock", data: dump(data) });
  }

  async getLatestDraft(householdId: string): Promise<DraftLock | null> {
    const item = await this.table.get(`HH#${householdId}`, "DRAFT#LATEST");
    if (!item) return null;
    const d = JSON.parse(item.data) as DraftLock;
    return d.expires_at > this.nowSeconds() ? d : null;
  }
}

export function createDynamoRepo(cfg: DynamoTableConfig & TableRepoOptions): TableRepo {
  return new TableRepo(new DynamoTable(cfg), cfg.nowSeconds ? { nowSeconds: cfg.nowSeconds } : {});
}
