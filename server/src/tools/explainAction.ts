/** explain_action (contracts §3.6, ticket M-9). */
import { ExplainActionInput, ExplainActionOutput } from "@butler/contracts";
import { fitSpoken, lintSpoken } from "../lib/lintSpoken.js";
import { lowerFirst, stripEndPunct } from "../lib/spoken.js";
import { resolveReceipt } from "./shared.js";
import { defineTool } from "./spec.js";

export const explainAction = defineTool({
  name: "explain_action",
  title: "Explain an action",
  description:
    "Use when the customer asks why Butler did something, or wants details about a specific action, purchase, message or booking. Returns the receipt with the reasons, the rule that applied and the alternatives Butler considered.",
  input: ExplainActionInput,
  output: ExplainActionOutput,
  annotations: { readOnlyHint: true, openWorldHint: false },
  ui: { view: "receipt", invoking: "Finding the details…", invoked: "Here's why" },
  fieldDescriptions: {
    action_id: "Exact action id, when known. One of action_id or reference is required.",
    reference: "The customer's words for the action, e.g. 'the drinks', 'the email to Tolu' or 'that'.",
  },
  async handler({ action_id, reference }, ctx) {
    const receipt = await resolveReceipt(ctx, { action_id, reference });
    let spoken = receipt.spoken_summary;
    if (!spoken || lintSpoken(spoken).length > 0) {
      const reason = receipt.reasons[0] ? ` because ${lowerFirst(stripEndPunct(receipt.reasons[0]))}` : "";
      spoken = fitSpoken(`${stripEndPunct(receipt.title)}${reason}.`);
    }
    return { data: { spoken_summary: spoken, receipt } };
  },
});
