/** answer_decision (contracts §3.4, ticket M-7). */
import type { Decision, DecisionOption, Receipt } from "@butler/contracts";
import { AnswerDecisionInput, AnswerDecisionOutput } from "@butler/contracts";
import { resolveChoice } from "../lib/choice.js";
import { ButlerError, notFound } from "../lib/errors.js";
import { fitSpoken, lintSpoken } from "../lib/lintSpoken.js";
import { stripEndPunct } from "../lib/spoken.js";
import { toUtcIso } from "../lib/time.js";
import { defineTool, type ToolContext } from "./spec.js";

export function receiptSpoken(r: Receipt): string {
  const own = r.spoken_summary;
  if (own && lintSpoken(own).length === 0) return own;
  return fitSpoken(own || `${stripEndPunct(r.title)}.`);
}

async function pickDecision(ctx: ToolContext, decisionId: string | undefined, choice: string): Promise<Decision> {
  const { repo } = ctx.deps;
  if (decisionId) {
    const d = await repo.findDecision(ctx.householdId, decisionId);
    if (!d) throw notFound("I couldn't find that question.");
    return d;
  }
  const pending = await repo.listPendingDecisions(ctx.householdId);
  if (pending.length === 0) throw notFound("There's nothing waiting on you right now.");
  if (pending.length === 1) return pending[0] as Decision;

  // Several pending: pick the one the choice text clearly belongs to, otherwise ask.
  const now = ctx.deps.now().getTime();
  const matches: Decision[] = [];
  const generic = /^(yes|no|ok|okay|sure|approve|reject|decline|skip|go ahead)\b/i.test(choice.trim());
  for (const d of pending) {
    // Only choose_option decisions can be told apart by the option the customer names.
    if (generic || d.kind !== "choose_option") continue;
    try {
      resolveChoice(d, choice, now);
      matches.push(d);
    } catch {
      /* not a match for this decision */
    }
  }
  if (matches.length === 1) return matches[0] as Decision;
  const cands = (matches.length > 1 ? matches : pending).slice(0, 3);
  throw new ButlerError("AMBIGUOUS_REFERENCE", `I have a few questions open. Which one: ${cands.map((d) => stripEndPunct(d.question)).join(" or ")}?`, {
    candidates: cands.map((d) => ({ id: d.decision_id, label: stripEndPunct(d.question) })),
  });
}

function title(o: DecisionOption | undefined): string {
  return o ? o.title : "that";
}

export const answerDecision = defineTool({
  name: "answer_decision",
  title: "Answer a decision",
  description:
    "Use when the customer chooses one of the options Butler offered, or approves or declines something Butler asked permission for. Returns the updated decision and, when something was done, the receipt for it.",
  input: AnswerDecisionInput,
  output: AnswerDecisionOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  ui: { view: "receipt", invoking: "Making it happen…", invoked: "Done" },
  fieldDescriptions: {
    decision_id: "Optional. Defaults to the single pending decision; if several are pending the tool asks which one.",
    choice: "An option id, 'approve' or 'reject', or the customer's words such as 'the second one', 'Sparkle' or 'yes'.",
  },
  async handler({ decision_id, choice }, ctx) {
    const { deps, householdId } = ctx;
    const decision = await pickDecision(ctx, decision_id, choice);

    // Replays are safe: report the outcome that already happened (idempotentHint).
    if (decision.status !== "pending") {
      if (decision.status === "executed" || decision.status === "approved") {
        const receipt = decision.result_action_id ? await deps.repo.getReceipt(householdId, decision.result_action_id) : null;
        return {
          data: {
            spoken_summary: receipt ? receiptSpoken(receipt) : "That one is already being handled.",
            decision,
            ...(receipt ? { receipt } : {}),
          },
        };
      }
      if (decision.status === "rejected") {
        return { data: { spoken_summary: "That one was already skipped.", decision } };
      }
      throw new ButlerError(
        decision.status === "failed" ? "UPSTREAM_UNAVAILABLE" : "NOT_FOUND",
        decision.status === "failed" ? "That one didn't go through earlier. Ask me to try the plan again." : "That question has expired.",
      );
    }

    const outcome = resolveChoice(decision, choice, deps.now().getTime());
    const agentCtx = { householdId, correlationId: ctx.correlationId };

    if (outcome.kind === "reject") {
      const rejected = await deps.repo.transitionDecision(householdId, decision.plan_id, decision.decision_id, "pending", "rejected", {
        ...(outcome.option ? { chosen_option_id: outcome.option.option_id } : {}),
      });
      if (!rejected) {
        const current = await deps.repo.getDecision(decision.plan_id, decision.decision_id);
        return { data: { spoken_summary: "That one was already handled.", decision: current ?? decision } };
      }
      const stamp = toUtcIso(deps.now());
      const needs = await deps.repo.listNeeds(decision.plan_id);
      const need = needs.find((n) => n.need_id === decision.need_id);
      if (need) await deps.repo.putNeed({ ...need, status: "skipped", note: "You said no.", updated_at: stamp });
      await deps.repo.touchPlan(householdId, decision.plan_id, stamp);
      deps.background("agent.resume_plan", () => deps.agent.resumePlan(agentCtx, decision.plan_id, decision.decision_id));
      const what = decision.kind === "approve_action" ? decision.options[0] : undefined;
      return {
        data: {
          spoken_summary: fitSpoken(what ? `Okay, I won't do that. I've skipped ${stripEndPunct(what.title).toLowerCase()}.` : "Okay, I'll skip it."),
          decision: rejected,
        },
      };
    }

    // choose / approve: the approval executor does the work synchronously (<= 8 s).
    try {
      const { decision: done, receipt } = await deps.executor.runDecision(
        { householdId, correlationId: ctx.correlationId },
        decision.decision_id,
        outcome.option.option_id,
      );
      deps.background("agent.resume_plan", () => deps.agent.resumePlan(agentCtx, decision.plan_id, decision.decision_id));
      return { data: { spoken_summary: receiptSpoken(receipt), decision: done, receipt } };
    } catch (e) {
      if (e instanceof ButlerError && e.code === "UPSTREAM_UNAVAILABLE") {
        // The executor didn't answer: mark the decision failed and the need blocked if nobody got to it first.
        const stamp = toUtcIso(deps.now());
        const failed = await deps.repo.transitionDecision(householdId, decision.plan_id, decision.decision_id, "pending", "failed");
        if (failed) {
          const needs = await deps.repo.listNeeds(decision.plan_id);
          const need = needs.find((n) => n.need_id === decision.need_id);
          if (need) {
            await deps.repo.putNeed({ ...need, status: "blocked", note: `Couldn't complete ${title(outcome.option).toLowerCase()}.`, updated_at: stamp });
          }
          await deps.repo.touchPlan(householdId, decision.plan_id, stamp);
        }
      }
      throw e;
    }
  },
});
