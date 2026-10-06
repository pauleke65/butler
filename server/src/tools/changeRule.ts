/** change_rule (contracts §3.9, ticket M-12): raise a limit (replace) or remove a rule, two-step confirm. */
import type { Rule } from "@butler/contracts";
import { ChangeRuleInput, ChangeRuleOutput } from "@butler/contracts";
import { ButlerError, notFound } from "../lib/errors.js";
import { fitSpoken } from "../lib/lintSpoken.js";
import { requireMatch, resolveReference, ruleCandidates } from "../lib/resolver.js";
import { lowerFirst, ruleHeadline } from "../lib/spoken.js";
import {
  activeSpoken,
  applyRuleNow,
  confirmPending,
  draftSpoken,
  proposeRemoval,
  proposeRule,
  removeRuleNow,
} from "./rulesFlow.js";
import { defineTool, type ToolContext } from "./spec.js";

const REMOVAL = /\b(remove|delete|drop|get rid of|stop|cancel|no longer|don'?t need|forget|clear|turn off|disable|scrap|lift)\b/i;

async function resolveRule(
  ctx: ToolContext,
  a: { rule_id?: string | undefined; reference?: string | undefined; change: string },
): Promise<Rule | undefined> {
  const { repo } = ctx.deps;
  if (a.rule_id) {
    const r = await repo.getRule(ctx.householdId, a.rule_id);
    if (!r) throw notFound("I couldn't find that rule.");
    return r;
  }
  const rules = (await repo.listRules(ctx.householdId, { activeOnly: true })).filter((r) => r.active);
  const phrase = a.reference ?? a.change;
  const res = resolveReference(phrase, ruleCandidates(rules), { now: ctx.deps.now().getTime(), minScore: 1 });
  if (res.kind === "none" && !a.reference) return undefined;
  return requireMatch(res, "I couldn't find that rule.").item;
}

export const changeRule = defineTool({
  name: "change_rule",
  title: "Change a rule",
  description:
    "Use when the customer wants to change or remove one of Butler's rules, such as raising a spending limit or removing an ask-first rule. Returns the proposed change to confirm, or the updated rule once confirmed.",
  input: ChangeRuleInput,
  output: ChangeRuleOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ui: { view: "rule", invoking: "Updating the rule…", invoked: "Here's the rule" },
  fieldDescriptions: {
    rule_id: "Optional exact rule id.",
    reference: "Optional: the customer's words for the rule, e.g. 'the spending limit' or 'the drinks rule'.",
    change: "What the customer wants, e.g. 'raise it to 80 dollars' or 'remove it'.",
    confirm: "Set to true when the customer says yes to the proposed change.",
  },
  async handler({ rule_id, reference, change, confirm }, ctx) {
    const { deps, householdId } = ctx;
    const lock = confirm === true ? await deps.repo.getLatestDraft(householdId) : null;
    const explicit = rule_id !== undefined || reference !== undefined;

    if (confirm === true) {
      // A pending proposal is the normal path; ignore it only when the caller named a different rule.
      const target = explicit ? await resolveRule(ctx, { rule_id, reference, change }) : undefined;
      const lockMatches = lock && (!target || lock.rule_id === target.rule_id || lock.replaces_rule_id === target.rule_id);
      if (lock && lockMatches) {
        const applied = await confirmPending(ctx, lock);
        return {
          data: { spoken_summary: activeSpoken(applied), rule: applied.rule, needs_confirmation: false },
        };
      }
      if (!target) throw new ButlerError("NOT_FOUND", "I don't have a change waiting for your yes.");
      // No pending proposal but an explicit, already-confirmed request: do it directly.
      if (REMOVAL.test(change)) {
        const applied = await removeRuleNow(ctx, target.rule_id);
        return { data: { spoken_summary: activeSpoken(applied), rule: applied.rule, needs_confirmation: false } };
      }
      const draft = await proposeRule(ctx, { correction: change, baseRuleId: target.rule_id });
      const applied = await applyRuleNow(ctx, draft.rule_id, target.rule_id);
      return { data: { spoken_summary: activeSpoken(applied), rule: applied.rule, needs_confirmation: false } };
    }

    const target = await resolveRule(ctx, { rule_id, reference, change });
    if (!target) throw notFound("I couldn't tell which rule you mean.");

    if (REMOVAL.test(change)) {
      await proposeRemoval(ctx, target);
      return {
        data: {
          spoken_summary: fitSpoken(`I'll remove this rule: ${lowerFirst(ruleHeadline(target))}. Should I go ahead?`),
          rule: target,
          needs_confirmation: true,
        },
      };
    }

    const draft = await proposeRule(ctx, { correction: change, baseRuleId: target.rule_id });
    return {
      data: {
        spoken_summary: draftSpoken(draft, "Should I make that change?"),
        rule: draft,
        needs_confirmation: true,
      },
    };
  },
});
