/** object_to_action (contracts §3.7, ticket M-10): correction -> draft rule -> confirm -> active rule. */
import { ObjectToActionInput, ObjectToActionOutput } from "@butler/contracts";
import {
  activeSpoken,
  confirmPending,
  draftSpoken,
  offeredUndo,
  proposeRule,
  requireLock,
} from "./rulesFlow.js";
import { resolveReceipt } from "./shared.js";
import { defineTool } from "./spec.js";

/** "Want me to refund that purchase too?" from an undo summary such as "Undo: Bought drinks for 7". */
export function undoQuestion(summary: string): string {
  const what = summary.replace(/^Undo:\s*/i, "");
  if (/^(bought|ordered)/i.test(what)) return "Want me to refund that purchase too?";
  if (/^booked/i.test(what)) return "Want me to cancel that booking too?";
  if (/^(added|created)/i.test(what)) return "Want me to remove that event too?";
  return "Want me to undo that too?";
}

export const objectToAction = defineTool({
  name: "object_to_action",
  title: "Object to an action",
  description:
    "Use when the customer disagrees with something Butler did or tells Butler how it should behave from now on, such as asking first, never doing something, or spending limits. Proposes a rule and asks the customer to confirm. Returns the draft rule, or the active rule once confirmed.",
  input: ObjectToActionInput,
  output: ObjectToActionOutput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  ui: { view: "rule", invoking: "Drafting that rule…", invoked: "Here's the rule" },
  fieldDescriptions: {
    correction: "The customer's correction in their own words, e.g. \"don't buy drinks without asking me\".",
    action_id: "Optional: the action the customer is objecting to.",
    reference: "Optional: the customer's words for that action, e.g. 'the drinks'.",
    confirm: "Set to true when the customer says yes to the proposed rule. Use the same correction as the first call.",
  },
  async handler({ correction, action_id, reference, confirm }, ctx) {
    if (confirm === true) {
      const lock = await requireLock(ctx);
      const applied = await confirmPending(ctx, lock);
      const undo = applied.removed ? undefined : await offeredUndo(ctx, applied.rule);
      const undoLine = undo ? undoQuestion(undo.summary) : undefined;
      return {
        data: {
          spoken_summary: activeSpoken(applied, undoLine),
          rule: applied.rule,
          needs_confirmation: false,
          ...(undo ? { offered_undo: undo } : {}),
        },
      };
    }

    // Step 1: resolve the action being objected to (optional), then ask the agent for a draft.
    let actionId = action_id;
    if (!actionId && reference) actionId = (await resolveReceipt(ctx, { reference })).action_id;
    else if (actionId) actionId = (await resolveReceipt(ctx, { action_id: actionId })).action_id;

    const rule = await proposeRule(ctx, { correction, actionId });
    return {
      data: {
        spoken_summary: draftSpoken(rule, "Should I make that a rule?"),
        rule,
        needs_confirmation: true,
      },
    };
  },
});

