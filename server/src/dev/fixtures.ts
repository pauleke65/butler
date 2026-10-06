/** Contract fixtures (packages/contracts/fixtures) + the seed household, loaded and validated with the zod schemas. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contact as ContactSchema,
  Decision as DecisionSchema,
  Household as HouseholdSchema,
  Plan as PlanSchema,
  Receipt as ReceiptSchema,
  Rule as RuleSchema,
  type Decision,
  type Receipt,
} from "@butler/contracts";
import { z } from "zod";
import type { Repo } from "../lib/repo.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../..");
export const FIXTURES_DIR = resolve(REPO_ROOT, "packages/contracts/fixtures");
export const SEED_DIR = resolve(REPO_ROOT, "seed");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export const fixtures = {
  planHosting: PlanSchema.parse(readJson(`${FIXTURES_DIR}/plan-hosting.json`)),
  planAway: PlanSchema.parse(readJson(`${FIXTURES_DIR}/plan-away.json`)),
  decisions: z.array(DecisionSchema).parse(readJson(`${FIXTURES_DIR}/decisions.json`)),
  receipts: z.array(ReceiptSchema).parse(readJson(`${FIXTURES_DIR}/receipts.json`)),
  rules: z.array(RuleSchema).parse(readJson(`${FIXTURES_DIR}/rules.json`)),
  household: HouseholdSchema.parse((readJson(`${SEED_DIR}/household.json`) as { household: unknown }).household),
  contacts: z.array(ContactSchema).parse(readJson(`${SEED_DIR}/contacts.json`)),
};

/** Wed 14 Oct 2026, 15:00 in New York, just after the fixture activity (which runs 14:04 to 14:40). */
export const NOW = new Date("2026-10-14T19:00:00+00:00");
export const HH = "hh_demo";

export function cleaningDecision(): Decision {
  return fixtures.decisions.find((d) => d.kind === "choose_option") as Decision;
}
export function drinksDecision(): Decision {
  return fixtures.decisions.find((d) => d.kind === "approve_action") as Decision;
}
export function receiptByTitle(title: string): Receipt {
  const r = fixtures.receipts.find((x) => x.title === title);
  if (!r) throw new Error(`no fixture receipt titled ${title}`);
  return r;
}

export async function seedRepo(repo: Repo, opts: { plans?: boolean; receipts?: boolean; rules?: boolean } = {}): Promise<void> {
  const { plans = true, receipts = true, rules = true } = opts;
  await repo.putHousehold(fixtures.household);
  for (const c of fixtures.contacts) await repo.putContact(HH, c);
  if (plans) {
    await repo.putPlan(fixtures.planHosting);
    await repo.putPlan(fixtures.planAway);
    for (const d of fixtures.decisions) await repo.putDecision(HH, d);
  }
  if (receipts) for (const r of fixtures.receipts) await repo.putReceipt(r);
  if (rules) for (const r of fixtures.rules) await repo.putRule(r);
}

