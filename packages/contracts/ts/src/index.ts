/**
 * Butler contracts — source of truth (see handoff/01-contracts.md).
 * Every schema registered through `def()` is exported to JSON Schema and from
 * there to Pydantic models (packages/contracts/py).
 */
import { z } from "zod";

export const registry = z.registry<{ id: string }>();

/** Register a schema under a stable id so it becomes a named $def in JSON Schema. */
export function def<T extends z.ZodType>(id: string, schema: T): T {
  registry.add(schema, { id });
  return schema;
}

// ───────────────────────────── primitives ─────────────────────────────

export const ISODateTime = def("ISODateTime", z.string().min(10));
export const Currency = def("Currency", z.literal("USD"));
export const Money = def(
  "Money",
  z.object({ amount_minor: z.number().int(), currency: Currency }),
);

export const Capability = def(
  "Capability",
  z.enum(["messages", "calendar", "supplies", "services", "context"]),
);
export const NeedStatus = def(
  "NeedStatus",
  z.enum(["doing", "done", "needs_you", "blocked", "skipped"]),
);
export const PlanStatus = def(
  "PlanStatus",
  z.enum(["planning", "active", "waiting_on_you", "complete", "cancelled"]),
);
export const SituationKind = def("SituationKind", z.enum(["hosting", "away", "running_low", "other"]));
export const ProductCategory = def(
  "ProductCategory",
  z.enum(["groceries", "drinks", "household", "toiletries", "gifts", "other"]),
);
export const ServiceType = def("ServiceType", z.enum(["cleaning", "ride", "repair", "pet_care"]));

export const GATEWAY_TOOL_NAMES = [
  "Messages___send_email",
  "Calendar___list_events",
  "Calendar___create_event",
  "Calendar___update_event",
  "Calendar___delete_event",
  "Supplies___search_products",
  "Supplies___checkout",
  "Supplies___refund",
  "Services___search_providers",
  "Services___book_service",
  "Services___cancel_booking",
  "Context___get_weather",
] as const;
export const GatewayToolName = def("GatewayToolName", z.enum(GATEWAY_TOOL_NAMES));

export const TEMPLATE_IDS = [
  "spend_cap",
  "ask_category",
  "ask_tool",
  "ask_non_contact",
  "never_contact",
  "protect_human_events",
  "never_tool",
] as const;
export const TemplateId = def("TemplateId", z.enum(TEMPLATE_IDS));
export const RuleEffect = def("RuleEffect", z.enum(["allow", "ask_first", "never"]));
export const PrincipalName = def("PrincipalName", z.enum(["butler-agent", "approval-executor"]));
export const PolicyDecision = def("PolicyDecision", z.enum(["ALLOW", "DENY"]));
export const ReceiptStatus = def(
  "ReceiptStatus",
  z.enum(["executed", "held_for_approval", "blocked", "failed", "undone"]),
);

export const ERROR_CODES = [
  "INVALID_INPUT",
  "NOT_FOUND",
  "AMBIGUOUS_REFERENCE",
  "NO_ACTIVE_PLAN",
  "DUPLICATE_PLAN",
  "RULE_UNSUPPORTED",
  "POLICY_PROPAGATING",
  "NOT_REVERSIBLE",
  "BLOCKED_BY_NEVER_RULE",
  "UPSTREAM_UNAVAILABLE",
  "INTERNAL",
] as const;
export const ErrorCode = def("ErrorCode", z.enum(ERROR_CODES));

// ───────────────────────────── core types (§2) ─────────────────────────────

export const Need = def(
  "Need",
  z.object({
    need_id: z.string(),
    plan_id: z.string(),
    label: z.string(),
    capability: Capability,
    status: NeedStatus,
    note: z.string().optional(),
    action_ids: z.array(z.string()),
    decision_id: z.string().optional(),
    updated_at: ISODateTime,
  }),
);

export const Plan = def(
  "Plan",
  z.object({
    plan_id: z.string(),
    household_id: z.string(),
    situation: z.string(),
    kind: SituationKind,
    title: z.string(),
    starts_at: ISODateTime.optional(),
    ends_at: ISODateTime.optional(),
    status: PlanStatus,
    needs: z.array(Need),
    last_status_read_at: ISODateTime.optional(),
    created_at: ISODateTime,
    updated_at: ISODateTime,
  }),
);

export const ActionDraft = def(
  "ActionDraft",
  z.object({
    tool: GatewayToolName,
    args: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }),
);

export const DecisionOption = def(
  "DecisionOption",
  z.object({
    option_id: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    price: Money.optional(),
    tradeoff: z.string(),
    image_url: z.string().optional(),
    simulated: z.boolean().optional(),
    action_draft: ActionDraft.optional(),
  }),
);

export const DecisionKind = def("DecisionKind", z.enum(["choose_option", "approve_action"]));
export const DecisionStatus = def(
  "DecisionStatus",
  z.enum(["pending", "approved", "rejected", "expired", "executed", "failed"]),
);

export const Decision = def(
  "Decision",
  z.object({
    decision_id: z.string(),
    plan_id: z.string(),
    need_id: z.string(),
    kind: DecisionKind,
    question: z.string(),
    options: z.array(DecisionOption),
    default_option_id: z.string().optional(),
    reason_held: z.object({ rule_id: z.string(), rule_text: z.string() }).optional(),
    status: DecisionStatus,
    chosen_option_id: z.string().optional(),
    result_action_id: z.string().optional(),
    created_at: ISODateTime,
    expires_at: ISODateTime.optional(),
  }),
);

export const Reasoning = def(
  "Reasoning",
  z.object({
    reasons: z.array(z.string()).default([]),
    context_used: z.array(z.string()).default([]),
    alternatives: z
      .array(z.object({ option: z.string(), rejected_because: z.string() }))
      .default([]),
    confidence: z.number().min(0).max(1).optional(),
  }),
);

export const Receipt = def(
  "Receipt",
  z.object({
    action_id: z.string(),
    household_id: z.string(),
    plan_id: z.string().optional(),
    need_id: z.string().optional(),
    decision_id: z.string().optional(),
    correlation_id: z.string(),
    situation: z.string().optional(),
    need_label: z.string().optional(),
    action: z.object({ tool: GatewayToolName, args: z.record(z.string(), z.unknown()) }),
    title: z.string(),
    status: ReceiptStatus,
    reasons: z.array(z.string()),
    context_used: z.array(z.string()),
    alternatives: z.array(z.object({ option: z.string(), rejected_because: z.string() })),
    authority: z.object({
      decision: PolicyDecision,
      principal: PrincipalName,
      rule_ids: z.array(z.string()),
      rule_texts: z.array(z.string()),
      gateway_request_id: z.string().optional(),
      evaluated_at: ISODateTime,
      matcher_gateway_agree: z.boolean(),
    }),
    cost: Money.optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    reversible: z.boolean(),
    undo_of: z.string().optional(),
    might_disagree: z.object({ score: z.number(), top_reason: z.string().optional() }),
    simulated: z.boolean(),
    spoken_summary: z.string(),
    created_at: ISODateTime,
  }),
);

export const RuleOrigin = def(
  "RuleOrigin",
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("default") }),
    z.object({
      type: z.literal("correction"),
      utterance: z.string(),
      action_id: z.string().optional(),
      created_at: ISODateTime,
    }),
  ]),
);

export const Rule = def(
  "Rule",
  z.object({
    rule_id: z.string(),
    household_id: z.string(),
    text: z.string(),
    effect: RuleEffect,
    template: TemplateId,
    params: z.record(z.string(), z.unknown()),
    cedar_statement: z.string(),
    policy_id: z.string().optional(),
    policy_status: z.enum(["draft", "creating", "active", "failed", "disabled"]),
    origin: RuleOrigin,
    active: z.boolean(),
    created_at: ISODateTime,
    updated_at: ISODateTime,
  }),
);

export const RuleDraft = def(
  "RuleDraft",
  z.object({
    template: z.union([TemplateId, z.literal("unsupported")]),
    params: z.record(z.string(), z.unknown()),
    text: z.string(),
    effect: RuleEffect,
    confidence: z.number().min(0).max(1),
  }),
);

export const Contact = def(
  "Contact",
  z.object({
    contact_id: z.string(),
    name: z.string(),
    first_name: z.string(),
    email: z.string(),
    relationship: z.enum(["friend", "family", "work", "service", "other"]).optional(),
    tags: z.array(z.string()).optional(),
  }),
);

export const Household = def(
  "Household",
  z.object({
    household_id: z.string(),
    name: z.string(),
    timezone: z.string(),
    currency: Currency,
    location: z.object({ lat: z.number(), lon: z.number() }).optional(),
  }),
);

export const Preference = def(
  "Preference",
  z.object({ key: z.string(), value: z.string(), learned_from: z.array(z.string()) }),
);

// ───────────────────────────── MCP tool I/O (§3) ─────────────────────────────

export const ToolError = def(
  "ToolError",
  z.object({
    code: ErrorCode,
    message_spoken: z.string(),
    candidates: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  }),
);

const envelope = {
  ok: z.literal(true),
  spoken_summary: z.string(),
};

export const HandleSituationInput = def(
  "HandleSituationInput",
  z.object({ situation: z.string().min(3).max(400), when: z.string().optional() }),
);
export const HandleSituationOutput = def(
  "HandleSituationOutput",
  z.object({ ...envelope, plan: Plan, handled_by_butler: z.number().int(), needs_you: z.number().int() }),
);

export const GetStatusInput = def("GetStatusInput", z.object({ plan_id: z.string().optional() }));
export const GetStatusOutput = def(
  "GetStatusOutput",
  z.object({
    ...envelope,
    plan: Plan,
    done_since_last_check: z.array(
      z.object({ need_id: z.string(), label: z.string(), note: z.string().optional() }),
    ),
    pending_decisions: z.array(Decision),
  }),
);

export const AnswerDecisionInput = def(
  "AnswerDecisionInput",
  z.object({ decision_id: z.string().optional(), choice: z.string() }),
);
export const AnswerDecisionOutput = def(
  "AnswerDecisionOutput",
  z.object({ ...envelope, decision: Decision, receipt: Receipt.optional() }),
);

export const ListActionsInput = def(
  "ListActionsInput",
  z.object({
    period: z.enum(["today", "this_week", "plan"]).optional(),
    filter: z.enum(["all", "purchases", "might_disagree", "blocked"]).optional(),
    plan_id: z.string().optional(),
  }),
);
export const ListActionsOutput = def(
  "ListActionsOutput",
  z.object({
    ...envelope,
    actions: z.array(Receipt),
    total_count: z.number().int(),
    filter: z.string(),
    period: z.string(),
  }),
);

export const ExplainActionInput = def(
  "ExplainActionInput",
  z.object({ action_id: z.string().optional(), reference: z.string().optional() }),
);
export const ExplainActionOutput = def("ExplainActionOutput", z.object({ ...envelope, receipt: Receipt }));

export const ObjectToActionInput = def(
  "ObjectToActionInput",
  z.object({
    correction: z.string().min(3),
    action_id: z.string().optional(),
    reference: z.string().optional(),
    confirm: z.boolean().optional(),
  }),
);
export const ObjectToActionOutput = def(
  "ObjectToActionOutput",
  z.object({
    ...envelope,
    rule: Rule,
    needs_confirmation: z.boolean(),
    offered_undo: z.object({ action_id: z.string(), summary: z.string() }).optional(),
  }),
);

export const ListRulesInput = def("ListRulesInput", z.object({}));
export const ListRulesOutput = def(
  "ListRulesOutput",
  z.object({ ...envelope, allowed: z.array(Rule), ask_first: z.array(Rule), never: z.array(Rule) }),
);

export const ChangeRuleInput = def(
  "ChangeRuleInput",
  z.object({
    rule_id: z.string().optional(),
    reference: z.string().optional(),
    change: z.string().min(2),
    confirm: z.boolean().optional(),
  }),
);
export const ChangeRuleOutput = def(
  "ChangeRuleOutput",
  z.object({ ...envelope, rule: Rule.optional(), needs_confirmation: z.boolean() }),
);

export const UndoActionInput = def(
  "UndoActionInput",
  z.object({ action_id: z.string().optional(), reference: z.string().optional() }),
);
export const UndoActionOutput = def(
  "UndoActionOutput",
  z.object({ ...envelope, original: Receipt, undo: Receipt }),
);

export const GetLedgerPageInput = def(
  "GetLedgerPageInput",
  z.object({
    cursor: z.string().optional(),
    filter: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
);
export const GetLedgerPageOutput = def(
  "GetLedgerPageOutput",
  z.object({ ...envelope, actions: z.array(Receipt), next_cursor: z.string().optional() }),
);
export const GetPlanInput = def("GetPlanInput", z.object({ plan_id: z.string() }));
export const GetPlanOutput = def("GetPlanOutput", z.object({ ...envelope, plan: Plan }));

// ───────────────────────────── agent ops (§5) ─────────────────────────────

const opBase = { household_id: z.string(), correlation_id: z.string() };

export const AgentRequest = def(
  "AgentRequest",
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("start_plan"), ...opBase, plan_id: z.string() }),
    z.object({ op: z.literal("resume_plan"), ...opBase, plan_id: z.string(), decision_id: z.string() }),
    z.object({
      op: z.literal("draft_rule"),
      ...opBase,
      correction: z.string(),
      action_id: z.string().optional(),
      base_rule_id: z.string().optional(),
    }),
    z.object({ op: z.literal("apply_rule"), ...opBase, rule_id: z.string() }),
    z.object({ op: z.literal("remove_rule"), ...opBase, rule_id: z.string() }),
  ]),
);

export const AgentResponse = def(
  "AgentResponse",
  z.object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
);

// ───────────────────────────── executor (§6) ─────────────────────────────

export const ExecutorRequest = def(
  "ExecutorRequest",
  z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("decision"),
      household_id: z.string(),
      correlation_id: z.string(),
      decision_id: z.string(),
      option_id: z.string(),
    }),
    z.object({
      mode: z.literal("undo"),
      household_id: z.string(),
      correlation_id: z.string(),
      action_id: z.string(),
    }),
  ]),
);

// ───────────────────────────── gateway action tools (§7) ─────────────────────────────

const actionCommon = {
  plan_id: z.string().optional(),
  need_id: z.string().optional(),
  idempotency_key: z.string(),
  correlation_id: z.string(),
};

export const SendEmailInput = def(
  "SendEmailInput",
  z.object({
    ...actionCommon,
    recipient_contact_ids: z.array(z.string()).optional(),
    recipient_email: z.string().optional(),
    subject: z.string(),
    body_text: z.string().max(2000),
    kind: z.enum(["invite", "reminder", "notice", "other"]),
  }),
);
export const ListEventsInput = def(
  "ListEventsInput",
  z.object({ ...actionCommon, from: ISODateTime, to: ISODateTime }),
);
export const CreateEventInput = def(
  "CreateEventInput",
  z.object({
    ...actionCommon,
    title: z.string(),
    start: ISODateTime,
    end: ISODateTime,
    attendee_contact_ids: z.array(z.string()).optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  }),
);
export const EventOwner = def("EventOwner", z.enum(["butler", "human"]));
export const UpdateEventInput = def(
  "UpdateEventInput",
  z.object({
    ...actionCommon,
    event_id: z.string(),
    event_owner: EventOwner,
    title: z.string().optional(),
    start: ISODateTime.optional(),
    end: ISODateTime.optional(),
  }),
);
export const DeleteEventInput = def(
  "DeleteEventInput",
  z.object({ ...actionCommon, event_id: z.string(), event_owner: EventOwner }),
);
export const SearchProductsInput = def(
  "SearchProductsInput",
  z.object({
    ...actionCommon,
    query: z.string(),
    category: ProductCategory.optional(),
    deliver_by: ISODateTime.optional(),
    max_results: z.number().int().min(1).max(5).optional(),
  }),
);
export const CheckoutInput = def(
  "CheckoutInput",
  z.object({
    ...actionCommon,
    merchant: z.string(),
    items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1),
    amount_minor: z.number().int().min(0),
    currency: Currency,
    category: ProductCategory,
    deliver_by: ISODateTime.optional(),
  }),
);
export const RefundInput = def("RefundInput", z.object({ ...actionCommon, order_id: z.string() }));
export const SearchProvidersInput = def(
  "SearchProvidersInput",
  z.object({
    ...actionCommon,
    service_type: ServiceType,
    date: z.string(),
    window: z.string().optional(),
  }),
);
export const BookServiceInput = def(
  "BookServiceInput",
  z.object({
    ...actionCommon,
    provider_id: z.string(),
    service_type: ServiceType,
    slot_start: ISODateTime,
    amount_minor: z.number().int().min(0),
    currency: Currency,
  }),
);
export const CancelBookingInput = def(
  "CancelBookingInput",
  z.object({ ...actionCommon, booking_id: z.string() }),
);
export const GetWeatherInput = def(
  "GetWeatherInput",
  z.object({ ...actionCommon, date: z.string(), lat: z.number().optional(), lon: z.number().optional() }),
);

/** Map each gateway tool to its input schema (used by the local gateway and Lambdas). */
export const ACTION_INPUT_SCHEMAS = {
  Messages___send_email: SendEmailInput,
  Calendar___list_events: ListEventsInput,
  Calendar___create_event: CreateEventInput,
  Calendar___update_event: UpdateEventInput,
  Calendar___delete_event: DeleteEventInput,
  Supplies___search_products: SearchProductsInput,
  Supplies___checkout: CheckoutInput,
  Supplies___refund: RefundInput,
  Services___search_providers: SearchProvidersInput,
  Services___book_service: BookServiceInput,
  Services___cancel_booking: CancelBookingInput,
  Context___get_weather: GetWeatherInput,
} as const;

export const TOOL_DESCRIPTIONS: Record<(typeof GATEWAY_TOOL_NAMES)[number], string> = {
  Messages___send_email:
    "Send an email to saved contacts (by contact id) or to a single other address. Use for invites, reminders and notices.",
  Calendar___list_events: "List calendar events in a time range, including who created each one.",
  Calendar___create_event: "Create a calendar event, optionally inviting contacts.",
  Calendar___update_event: "Change the title or time of an existing calendar event.",
  Calendar___delete_event: "Delete a calendar event.",
  Supplies___search_products:
    "Search the product catalogue. Returns up to 5 products with merchant, price and delivery estimate.",
  Supplies___checkout:
    "Buy items from one merchant. amount_minor must equal the items' total in cents and category must match the items.",
  Supplies___refund: "Refund a previous order in full.",
  Services___search_providers: "Find providers (cleaners, rides, repairs, pet care) with price and an available slot.",
  Services___book_service: "Book a provider's slot.",
  Services___cancel_booking: "Cancel a booking.",
  Context___get_weather: "Get the weather forecast for a date.",
};

// ───────────────────────────── debug API (§11) ─────────────────────────────

export const PolicyEvent = def(
  "PolicyEvent",
  z.object({
    at: ISODateTime,
    action_id: z.string(),
    principal: PrincipalName,
    tool: GatewayToolName,
    decision: PolicyDecision,
    rule_ids: z.array(z.string()),
    rule_texts: z.array(z.string()),
    amount_minor: z.number().int().optional(),
    gateway_request_id: z.string().optional(),
  }),
);

// ───────────────────────────── helpers ─────────────────────────────

export type Money = z.infer<typeof Money>;
export type Need = z.infer<typeof Need>;
export type Plan = z.infer<typeof Plan>;
export type Decision = z.infer<typeof Decision>;
export type DecisionOption = z.infer<typeof DecisionOption>;
export type ActionDraft = z.infer<typeof ActionDraft>;
export type Receipt = z.infer<typeof Receipt>;
export type Rule = z.infer<typeof Rule>;
export type RuleDraft = z.infer<typeof RuleDraft>;
export type Contact = z.infer<typeof Contact>;
export type Household = z.infer<typeof Household>;
export type Preference = z.infer<typeof Preference>;
export type Reasoning = z.infer<typeof Reasoning>;
export type ToolError = z.infer<typeof ToolError>;
export type PolicyEvent = z.infer<typeof PolicyEvent>;
export type GatewayToolName = z.infer<typeof GatewayToolName>;
export type TemplateId = z.infer<typeof TemplateId>;
export type Capability = z.infer<typeof Capability>;
export type NeedStatus = z.infer<typeof NeedStatus>;
export type SituationKind = z.infer<typeof SituationKind>;
export type ProductCategory = z.infer<typeof ProductCategory>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type AgentRequest = z.infer<typeof AgentRequest>;
export type AgentResponse = z.infer<typeof AgentResponse>;
export type ExecutorRequest = z.infer<typeof ExecutorRequest>;

/** Tool name used by Cedar: AgentCore::Action::"Supplies___checkout". */
export function splitTool(tool: GatewayToolName): { target: string; name: string } {
  const [target, name] = tool.split("___") as [string, string];
  return { target, name };
}

/** Tools whose undo is another gateway tool; others are not reversible. */
export const UNDO_TOOL: Partial<Record<GatewayToolName, GatewayToolName>> = {
  Supplies___checkout: "Supplies___refund",
  Services___book_service: "Services___cancel_booking",
  Calendar___create_event: "Calendar___delete_event",
};
