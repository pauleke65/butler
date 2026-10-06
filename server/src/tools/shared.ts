/** Helpers shared by several tools. */
import type { Contact, Decision, Need, Plan, Receipt } from "@butler/contracts";
import { ButlerError, notFound } from "../lib/errors.js";
import { receiptCandidates, requireMatch, resolveReference } from "../lib/resolver.js";
import type { ToolContext } from "./spec.js";

export const TERMINAL_PLAN_STATUSES = new Set<Plan["status"]>(["complete", "cancelled"]);

export async function householdTimezone(ctx: ToolContext): Promise<string> {
  const hh = await ctx.deps.repo.getHousehold(ctx.householdId);
  return hh?.timezone ?? ctx.deps.config.defaultTimezone;
}

export function newestFirst(receipts: Receipt[]): Receipt[] {
  return [...receipts].sort((a, b) => (a.action_id < b.action_id ? 1 : a.action_id > b.action_id ? -1 : 0));
}

/**
 * A services need always ends up with the customer (Butler offers 2-3 providers and never books on its own),
 * so while it is still `doing` it already counts as "needs you".
 */
export function needsCustomer(n: Need): boolean {
  return n.status === "needs_you" || (n.capability === "services" && n.status === "doing");
}

export function countNeeds(needs: Need[]): { handled_by_butler: number; needs_you: number } {
  return {
    handled_by_butler: needs.filter((n) => !needsCustomer(n) && n.status !== "blocked" && n.status !== "skipped").length,
    needs_you: needs.filter(needsCustomer).length,
  };
}

/** Load a plan the household owns or throw NOT_FOUND. */
export async function requirePlan(ctx: ToolContext, planId: string): Promise<Plan> {
  const plan = await ctx.deps.repo.getPlan(ctx.householdId, planId);
  if (!plan) throw notFound("I couldn't find that plan.");
  return plan;
}

export async function pendingDecisionsFor(ctx: ToolContext, planId: string): Promise<Decision[]> {
  const all = await ctx.deps.repo.listDecisions(planId);
  return all.filter((d) => d.status === "pending").sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** Resolve an action by id or by spoken reference (last 50 receipts). */
export async function resolveReceipt(
  ctx: ToolContext,
  args: { action_id?: string | undefined; reference?: string | undefined },
): Promise<Receipt> {
  const { repo } = ctx.deps;
  if (args.action_id) {
    const r = await repo.getReceipt(ctx.householdId, args.action_id);
    if (r) return r;
    if (!args.reference) throw notFound("I couldn't find that action.");
  }
  if (!args.reference) {
    throw new ButlerError("INVALID_INPUT", "Which action do you mean?", { details: "provide action_id or reference" });
  }
  const [receipts, contacts, tz] = await Promise.all([
    repo.listReceipts(ctx.householdId, { newestFirst: true, limit: 50 }),
    repo.listContacts(ctx.householdId),
    householdTimezone(ctx),
  ]);
  const now = ctx.deps.now();
  const cands = receiptCandidates(receipts.filter(isUserAction), contacts as Contact[], now, tz);
  const res = resolveReference(args.reference, cands, { now: now.getTime() });
  return requireMatch(res, "I couldn't find that one.").item;
}

export function isReceiptPurchase(r: Receipt): boolean {
  return (r.action.tool === "Supplies___checkout" || r.action.tool === "Services___book_service") && r.status === "executed";
}

export function isBlockedLike(r: Receipt): boolean {
  return r.status === "held_for_approval" || r.status === "blocked";
}

export const MIGHT_DISAGREE_THRESHOLD = 0.3;

/** Read-only tools write receipts too (searches, listings); they are never "actions" the customer cares about. */
export const READ_ONLY_TOOLS = new Set<string>([
  "Calendar___list_events",
  "Supplies___search_products",
  "Services___search_providers",
  "Context___get_weather",
]);

export function isUserAction(r: Receipt): boolean {
  return !READ_ONLY_TOOLS.has(r.action.tool);
}

export function applyFilter(all: Receipt[], filter: string): Receipt[] {
  const receipts = all.filter(isUserAction);
  switch (filter) {
    case "purchases":
      return receipts.filter(isReceiptPurchase);
    case "might_disagree":
      return receipts.filter((r) => r.might_disagree.score >= MIGHT_DISAGREE_THRESHOLD);
    case "blocked":
      return receipts.filter(isBlockedLike);
    default:
      return receipts;
  }
}
