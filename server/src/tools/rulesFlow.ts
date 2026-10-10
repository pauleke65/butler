/**
 * Shared two-step rule flow for object_to_action and change_rule (contracts §3.7, §3.9).
 *
 * Step 1 stores a draft (agent `draft_rule`) and writes the DRAFT#LATEST lock (10 minute TTL).
 * Step 2 (`confirm: true`) reads the lock and applies it (agent `apply_rule`); for a replacement the
 * new policy is created BEFORE the old one is removed so there is never a gap in enforcement.
 */
import type { Receipt, Rule } from "@butler/contracts";
import { UNDO_TOOL } from "@butler/contracts";
import { ButlerError, notFound } from "../lib/errors.js";
import type { DraftLock } from "../lib/repo.js";
import { fitSpoken } from "../lib/lintSpoken.js";
import { ruleAsPromise, ruleHeadline, lowerFirst } from "../lib/spoken.js";
import type { ToolContext } from "./spec.js";

export const PROPAGATING_SPOKEN = "Done. It'll take effect in a moment.";

export async function proposeRule(
  ctx: ToolContext,
  a: { correction: string; actionId?: string | undefined; baseRuleId?: string | undefined },
): Promise<Rule> {
  const { deps, householdId } = ctx;
  const { rule } = await deps.agent.draftRule(
    { householdId, correlationId: ctx.correlationId },
    { correction: a.correction, actionId: a.actionId, baseRuleId: a.baseRuleId },
  );
  // The agent stores drafts itself; make sure the lock target exists even if it didn't.
  const stored = await deps.repo.getRule(householdId, rule.rule_id);
  if (!stored) await deps.repo.putRule(rule);
  await deps.repo.setLatestDraft(householdId, {
    rule_id: rule.rule_id,
    intent: a.baseRuleId ? "replace" : "new",
    ...(a.baseRuleId ? { replaces_rule_id: a.baseRuleId } : {}),
  });
  return stored ?? rule;
}

export async function proposeRemoval(ctx: ToolContext, rule: Rule): Promise<void> {
  await ctx.deps.repo.setLatestDraft(ctx.householdId, { rule_id: rule.rule_id, intent: "remove" });
}

export interface Applied {
  rule: Rule;
  propagating: boolean;
  removed?: boolean;
}

export async function applyRuleNow(ctx: ToolContext, ruleId: string, replacesRuleId?: string): Promise<Applied> {
  const { deps, householdId } = ctx;
  const agentCtx = { householdId, correlationId: ctx.correlationId };
  const current = await deps.repo.getRule(householdId, ruleId);
  if (!current) throw notFound("I couldn't find that rule.");

  // Replays of a confirm are safe.
  if (current.active && current.policy_status === "active") return { rule: current, propagating: false };

  const res = await deps.agent.applyRule(agentCtx, ruleId);
  const rule = res.rule ?? (await deps.repo.getRule(householdId, ruleId)) ?? current;

  if (replacesRuleId && replacesRuleId !== ruleId) {
    const old = await deps.repo.getRule(householdId, replacesRuleId);
    if (old?.active) {
      try {
        await deps.agent.removeRule(agentCtx, replacesRuleId);
      } catch (e) {
        ctx.log.log("error", "rules.replace.remove_old_failed", { old_rule_id: replacesRuleId, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { rule, propagating: res.propagating || rule.policy_status === "creating" };
}

export async function removeRuleNow(ctx: ToolContext, ruleId: string): Promise<Applied> {
  const { deps, householdId } = ctx;
  const current = await deps.repo.getRule(householdId, ruleId);
  if (!current) throw notFound("I couldn't find that rule.");
  if (!current.active && current.policy_status === "disabled") return { rule: current, propagating: false, removed: true };
  const res = await deps.agent.removeRule({ householdId, correlationId: ctx.correlationId }, ruleId);
  const rule = res.rule ?? (await deps.repo.getRule(householdId, ruleId)) ?? { ...current, active: false, policy_status: "disabled" as const };
  return { rule, propagating: false, removed: true };
}

/** Run whatever the DRAFT#LATEST lock says is pending. */
export async function confirmPending(ctx: ToolContext, lock: DraftLock): Promise<Applied> {
  if (lock.intent === "remove") return removeRuleNow(ctx, lock.rule_id);
  return applyRuleNow(ctx, lock.rule_id, lock.replaces_rule_id);
}

export async function requireLock(ctx: ToolContext): Promise<DraftLock> {
  const lock = await ctx.deps.repo.getLatestDraft(ctx.householdId);
  if (!lock) throw new ButlerError("NOT_FOUND", "I don't have a rule waiting for your yes.");
  return lock;
}

/** First-person promise sentence for a rule: "I'll ask before buying drinks". */
export function promise(rule: Rule): string {
  return ruleAsPromise(rule.text);
}

export function draftSpoken(rule: Rule, question: string): string {
  return fitSpoken(`From now on, ${promise(rule)}. ${question}`);
}

export function activeSpoken(applied: Applied, undoSummary?: string): string {
  if (applied.removed) return fitSpoken(`Done. I removed the rule: ${lowerFirst(ruleHeadline(applied.rule))}.`);
  // A rule still activating on AgentCore is already honoured by Butler itself (the action wrapper holds matching
  // actions), so the customer gets the same confirmation either way.
  const base = `Done, from now on ${promise(applied.rule)}.`;
  return fitSpoken(undoSummary ? `${base} ${undoSummary}` : base);
}

/** Offer to undo the action that triggered a correction when it is still reversible. */
export async function offeredUndo(ctx: ToolContext, rule: Rule): Promise<{ action_id: string; summary: string } | undefined> {
  if (rule.origin.type !== "correction" || !rule.origin.action_id) return undefined;
  const receipt: Receipt | null = await ctx.deps.repo.getReceipt(ctx.householdId, rule.origin.action_id);
  if (!receipt || receipt.status !== "executed" || !receipt.reversible || !UNDO_TOOL[receipt.action.tool]) return undefined;
  return { action_id: receipt.action_id, summary: `Undo: ${receipt.title}` };
}
