/** undo_action (contracts §3.10, ticket M-11). Reversal runs through the approval executor. */
import { UNDO_TOOL, UndoActionInput, UndoActionOutput } from "@butler/contracts";
import { ButlerError } from "../lib/errors.js";
import { fitSpoken, lintSpoken } from "../lib/lintSpoken.js";
import { lowerFirst, stripEndPunct } from "../lib/spoken.js";
import { resolveReceipt } from "./shared.js";
import { defineTool } from "./spec.js";

export const undoAction = defineTool({
  name: "undo_action",
  title: "Undo an action",
  description:
    "Use when the customer wants Butler to reverse something it did, such as cancelling a booking, refunding a purchase or removing a calendar event. Returns the original receipt and the receipt for the reversal.",
  input: UndoActionInput,
  output: UndoActionOutput,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  ui: { view: "receipt", invoking: "Undoing that…", invoked: "Undone" },
  fieldDescriptions: {
    action_id: "Exact action id, when known. One of action_id or reference is required.",
    reference: "The customer's words for the action to reverse, e.g. 'the cleaner booking' or 'that'.",
  },
  async handler({ action_id, reference }, ctx) {
    const { deps, householdId } = ctx;
    const original = await resolveReceipt(ctx, { action_id, reference });

    if (original.status === "undone") throw new ButlerError("NOT_REVERSIBLE", "That one has already been undone.");
    if (original.action.tool === "Messages___send_email") {
      throw new ButlerError("NOT_REVERSIBLE", "I can't undo an email once it's sent.");
    }
    if (!UNDO_TOOL[original.action.tool] || !original.reversible || original.status !== "executed") {
      throw new ButlerError("NOT_REVERSIBLE");
    }

    const res = await deps.executor.undo({ householdId, correlationId: ctx.correlationId }, original.action_id);
    const refreshed = res.original ?? (await deps.repo.getReceipt(householdId, original.action_id)) ?? { ...original, status: "undone" as const };
    const own = res.undo.spoken_summary;
    const spoken =
      own && lintSpoken(own).length === 0 ? own : fitSpoken(`Okay, I undid ${lowerFirst(stripEndPunct(original.title))}.`);
    return { data: { spoken_summary: spoken, original: refreshed, undo: res.undo } };
  },
});
