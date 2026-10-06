/** Fixture scenarios: which tool result feeds which view. Every scenario runs the REAL tool on the fixture server. */
export interface Scenario {
  id: string;
  title: string;
  view: "plan" | "options" | "receipt" | "actions" | "rule" | "rules";
  /** Tool calls run in order; the LAST result is delivered to the view. `$ids.x` is replaced from /__fixtures/ids. */
  steps: Array<{ tool: string; args: Record<string, unknown> }>;
}

export const SCENARIOS: Scenario[] = [
  { id: "plan-hosting", title: "Plan: hosting, cleaner pending", view: "plan", steps: [{ tool: "get_plan", args: { plan_id: "$ids.plan_hosting" } }] },
  { id: "plan-away", title: "Plan: away, drinks held by a rule", view: "plan", steps: [{ tool: "get_status", args: {} }] },
  { id: "options", title: "Options: pick a cleaner (carousel)", view: "options", steps: [{ tool: "get_status", args: { plan_id: "$ids.plan_hosting" } }] },
  { id: "approval", title: "Options: approve held drinks", view: "options", steps: [{ tool: "get_status", args: {} }] },
  { id: "receipt-allowed", title: "Receipt: drinks, ALLOWED", view: "receipt", steps: [{ tool: "explain_action", args: { action_id: "$ids.receipt_drinks" } }] },
  { id: "receipt-booking", title: "Receipt: booking via approval", view: "receipt", steps: [{ tool: "explain_action", args: { action_id: "$ids.receipt_booking" } }] },
  { id: "receipt-held", title: "Receipt: HELD (DENY by rule)", view: "receipt", steps: [{ tool: "explain_action", args: { action_id: "$ids.receipt_held" } }] },
  { id: "receipt-blocked", title: "Receipt: BLOCKED (never rule)", view: "receipt", steps: [{ tool: "explain_action", args: { action_id: "$ids.receipt_blocked" } }] },
  { id: "receipt-failed", title: "Receipt: failed", view: "receipt", steps: [{ tool: "explain_action", args: { action_id: "$ids.receipt_failed" } }] },
  { id: "actions", title: "Actions: what Butler did", view: "actions", steps: [{ tool: "list_actions", args: {} }] },
  { id: "actions-might", title: "Actions: might disagree", view: "actions", steps: [{ tool: "list_actions", args: { filter: "might_disagree" } }] },
  { id: "ledger", title: "Actions: fullscreen ledger (See more)", view: "actions", steps: [{ tool: "list_actions", args: {} }] },
  { id: "rule-draft", title: "Rule: draft to confirm", view: "rule", steps: [{ tool: "object_to_action", args: { correction: "Don't buy drinks without asking me." } }] },
  {
    id: "rule-active",
    title: "Rule: active after confirm",
    view: "rule",
    steps: [
      { tool: "object_to_action", args: { correction: "Don't buy drinks without asking me.", reference: "the drinks" } },
      { tool: "object_to_action", args: { correction: "yes", confirm: true } },
    ],
  },
  { id: "rules", title: "Rules: grouped list", view: "rules", steps: [{ tool: "list_rules", args: {} }] },
  { id: "error", title: "Error envelope", view: "plan", steps: [{ tool: "get_status", args: { plan_id: "plan_missing" } }] },
];

export const DEVICES = {
  show8: { label: "Echo Show 8", width: 1280, height: 800 },
  show15: { label: "Echo Show 15", width: 1920, height: 1080 },
} as const;
export type DeviceId = keyof typeof DEVICES;
