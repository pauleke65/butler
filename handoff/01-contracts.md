# 01 — Contracts (source of truth)

Every interface between workstreams is defined here. Types are written in TypeScript notation for readability. **Ticket SET-6** turns them into a shared package:

- `packages/contracts/ts`: TypeScript types + JSON Schemas (zod) used by the MCP server, views and simulator plugin
- `packages/contracts/py`: Pydantic v2 models generated from the same JSON Schemas, used by the agent, Lambdas and rule compiler

Change process: PR to this file → regenerate the package → then code. Owners per section are listed in brackets.

**Contents**
1. Conventions
2. Core types
3. Alexa-facing MCP tools (Head C)
4. MCP Apps views (Head C)
5. Agent runtime operations (Head B)
6. Approval executor (Head B)
7. Gateway action tools (Head B; registration by Head A)
8. Action-call wrapper and receipts (Head B)
9. Rules, templates and Cedar (Head A)
10. Data model, DynamoDB (Head A)
11. Debug API for the Black Box panel (Head A)
12. Prompts (Heads B and C)
13. Simulator ↔ server expectations (Head D)
14. Error codes
15. Spoken-text style rules

---

## 1. Conventions

| Topic | Rule |
|---|---|
| IDs | ULIDs with prefixes: `hh_`, `mem_`, `c_` (contact), `plan_`, `need_`, `dec_`, `opt_`, `act_`, `rule_`, `ord_`, `bkg_`, `evt_`. ULIDs sort by time |
| Time | ISO 8601 with offset in all payloads (`2026-10-16T19:00:00-04:00`). Store UTC plus household timezone |
| Money | `amount_minor: integer` (cents) + `currency: "USD"`. Never floats. Spoken as "42 dollars" |
| Correlation | Every request carries `correlation_id` (ULID). Log it everywhere; it ends up on receipts |
| Idempotency | Every side-effecting action carries `idempotency_key` = `${plan_id}:${need_id}:${action_kind}:${n}`; Lambdas store keys with 7-day TTL and return the original result on replay |
| Household | Resolved server-side from the caller token (`sub` → `household_id` mapping in env `HOUSEHOLD_BY_SUB`, demo maps everything to `hh_demo`). Never accepted from tool input |
| Simulated data | Any object from the simulated catalogue/providers carries `simulated: true`; views show a "Simulated" badge |
| Naming | Tools `snake_case`; JSON fields `snake_case`; TypeScript code may map to camelCase internally |

---

## 2. Core types

```ts
type ISODateTime = string;           // 2026-10-16T19:00:00-04:00
type Money = { amount_minor: number; currency: "USD" };

type Capability = "messages" | "calendar" | "supplies" | "services" | "context";

type NeedStatus = "doing" | "done" | "needs_you" | "blocked" | "skipped";

interface Need {
  need_id: string;
  plan_id: string;
  label: string;                     // "Invite 6 guests" (≤ 40 chars, display)
  capability: Capability;
  status: NeedStatus;
  note?: string;                     // one line: "Sent to 6 people at 2:04 PM"
  action_ids: string[];              // receipts linked to this need
  decision_id?: string;              // set when status = needs_you
  updated_at: ISODateTime;
}

type PlanStatus = "planning" | "active" | "waiting_on_you" | "complete" | "cancelled";
type SituationKind = "hosting" | "away" | "running_low" | "other";

interface Plan {
  plan_id: string;
  household_id: string;
  situation: string;                 // customer's words, verbatim
  kind: SituationKind;
  title: string;                     // "Dinner for 6, Friday 7 PM"
  starts_at?: ISODateTime;
  ends_at?: ISODateTime;
  status: PlanStatus;
  needs: Need[];
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

interface DecisionOption {
  option_id: string;
  title: string;                     // "Sparkle Cleaners"
  subtitle?: string;                 // "Thu 3 PM · 4.8 stars"
  price?: Money;
  tradeoff: string;                  // "Cheapest, but only Thursday"
  image_url?: string;
  simulated?: boolean;
  action_draft?: ActionDraft;        // what runs if chosen; absent for "skip"
}

type DecisionKind = "choose_option" | "approve_action";
type DecisionStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";

interface Decision {
  decision_id: string;
  plan_id: string;
  need_id: string;
  kind: DecisionKind;
  question: string;                  // spoken-ready: "Which cleaner should I book?"
  options: DecisionOption[];         // 2–5 for choose_option; exactly 1 for approve_action
  default_option_id?: string;
  reason_held?: {                    // present when created because policy denied the agent
    rule_id: string;
    rule_text: string;               // "Ask me before buying drinks."
  };
  status: DecisionStatus;
  chosen_option_id?: string;
  result_action_id?: string;
  created_at: ISODateTime;
  expires_at?: ISODateTime;
}

interface ActionDraft {
  tool: GatewayToolName;             // see §7, e.g. "Supplies___checkout"
  args: Record<string, unknown>;     // exactly the tool's input schema
  summary: string;                   // "Buy drinks for 7 people, 31 dollars"
}

type ReceiptStatus = "executed" | "held_for_approval" | "blocked" | "failed" | "undone";
type PolicyDecision = "ALLOW" | "DENY";
type PrincipalName = "butler-agent" | "approval-executor";

interface Receipt {
  action_id: string;
  household_id: string;
  plan_id?: string;
  need_id?: string;
  decision_id?: string;              // set when executed after approval
  correlation_id: string;
  situation?: string;
  need_label?: string;
  action: { tool: GatewayToolName; args: Record<string, unknown> };
  title: string;                     // "Bought drinks"
  status: ReceiptStatus;
  reasons: string[];                 // 1–3 short reasons, most important first
  context_used: string[];            // "calendar: Fri 7 PM dinner", "contacts: 6 invited"
  alternatives: { option: string; rejected_because: string }[];  // 0–3
  authority: {
    decision: PolicyDecision;
    principal: PrincipalName;
    rule_ids: string[];              // from our rule matcher (D7)
    rule_texts: string[];
    gateway_request_id?: string;
    evaluated_at: ISODateTime;
    matcher_gateway_agree: boolean;  // false = parity bug, alert in logs
  };
  cost?: Money;
  result?: Record<string, unknown>;  // provider refs: message_id, event_id, payment_ref, booking_id
  reversible: boolean;
  undo_of?: string;                  // action_id this receipt undid
  might_disagree: { score: number; top_reason?: string };
  simulated: boolean;
  spoken_summary: string;            // see §15
  created_at: ISODateTime;
}

type RuleEffect = "allow" | "ask_first" | "never";

interface Rule {
  rule_id: string;
  household_id: string;
  text: string;                      // "Ask me before buying drinks."
  effect: RuleEffect;
  template: TemplateId;              // §9
  params: Record<string, unknown>;   // template params
  cedar_statement: string;           // compiled, never model-written
  policy_id?: string;                // AgentCore policy id
  policy_status: "draft" | "creating" | "active" | "failed" | "disabled";
  origin:
    | { type: "default" }
    | { type: "correction"; utterance: string; action_id?: string; created_at: ISODateTime };
  active: boolean;
  created_at: ISODateTime;
  updated_at: ISODateTime;
}

interface RuleDraft {                 // produced by the model, validated, never trusted raw
  template: TemplateId;
  params: Record<string, unknown>;
  text: string;
  effect: RuleEffect;
  confidence: number;                // 0–1; < 0.6 → ask the customer to rephrase
}

interface Contact {
  contact_id: string;
  name: string;
  first_name: string;
  email: string;
  relationship?: "friend" | "family" | "work" | "service" | "other";
  tags?: string[];                   // "parents", "book-club"
}
```

---

## 3. Alexa-facing MCP tools [Head C]

### 3.1 Shared response envelope

Every tool returns a `CallToolResult` shaped like this (matches the example in Amazon's Alexa+ client lifecycle docs):

```jsonc
{
  "structuredContent": {
    "ok": true,
    "spoken_summary": "…",          // §15; Alexa builds speech from this + data
    /* tool-specific fields (below) */
  },
  "content": [{ "type": "text", "text": "<JSON.stringify(structuredContent)>" }],
  "_meta": {
    "ui": {
      "resourceUri": "ui://butler/<view>",
      "invoking": "Checking on Friday…",   // ≤ 30 chars
      "invoked": "Here's Friday"             // ≤ 30 chars
    }
  }
}
```

Errors: `isError: true`, `structuredContent = { ok: false, error: { code, message_spoken, candidates? } }` (codes in §14). **Never** return an empty result.

Every tool definition also carries:
- `title`, `description` (pattern: *Use when … Returns …*), `icons` (one 64×64 SVG), `inputSchema`, `outputSchema`
- `_meta.ui.resourceUri` on the **definition** too (MCP Apps requires it on the tool; Alexa's example shows it on the result; we set both)
- `annotations`: `readOnlyHint` / `destructiveHint` / `idempotentHint` as listed per tool

Server name `butler`, version `0.1.0`, `protocolVersion` negotiated; must support **`2025-11-25`** (S-2 verifies), and also accept `2025-03-26` (what Alexa+'s own client sends today).

### 3.2 `handle_situation`

| | |
|---|---|
| Description | Use when the customer describes something coming up or a state of their home, such as guests visiting, travelling, or running low on supplies. Creates a plan, starts working on it in the background, and returns what Butler will handle and what needs the customer. |
| Annotations | `readOnlyHint: false`, `idempotentHint: false` |
| View | `ui://butler/plan` |
| Latency budget | ≤ 2.5 s (fast needs pass §12.1 + DynamoDB write + async agent invoke) |

Input:
```ts
{
  situation: string;   // required, 3–400 chars, customer's words
  when?: string;       // optional ISO or natural phrase ("Friday at 7"); server resolves with household tz
}
```
Output (`structuredContent` fields beyond the envelope):
```ts
{ plan: Plan; handled_by_butler: number; needs_you: number }
```
Behaviour:
1. Run the fast needs pass (§12.1). On timeout/failure use the keyword fallback (§12.1).
2. Write Plan + Needs (`status: "doing"` or `"needs_you"` for services).
3. Invoke agent `start_plan` asynchronously (§5). Do not await completion.
4. If an active plan with the same `kind` and overlapping time exists, return `error.code = "DUPLICATE_PLAN"` with `candidates` = that plan, so Alexa can ask "update the existing plan?" (MVP: just return the existing plan with `ok: true` and spoken "You already have a plan for Friday. Here's where it stands.").

Spoken example: "Got it, six guests Friday at 7. I'll handle invites, the calendar and drinks, and I'll check with you on cleaning."

### 3.3 `get_status`

| | |
|---|---|
| Description | Use when the customer asks how a plan is going, what's left, or whether Butler needs anything from them. Returns progress, what changed since they last asked, and any decisions waiting for them. |
| Annotations | `readOnlyHint: true` |
| View | `ui://butler/plan`, or `ui://butler/options` if exactly one decision is pending and it is `choose_option` |

Input: `{ plan_id?: string }` (default: most recently updated plan with status ≠ complete/cancelled; if none → `NO_ACTIVE_PLAN`)

Output:
```ts
{
  plan: Plan;
  done_since_last_check: { need_id: string; label: string; note?: string }[];
  pending_decisions: Decision[];   // max 3, oldest first
}
```
"Since last check" uses `Plan.last_status_read_at` (updated on every call).

Spoken example: "Invites went to all six, Friday's on the calendar, and I bought drinks for 42 dollars. One thing for you: which cleaner should I book?"

### 3.4 `answer_decision`

| | |
|---|---|
| Description | Use when the customer chooses one of the options Butler offered, or approves or declines something Butler asked permission for. |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` |
| View | `ui://butler/receipt` |

Input:
```ts
{
  decision_id?: string;     // optional: default = the single pending decision; if several → AMBIGUOUS_REFERENCE with candidates
  choice: string;           // option_id, or "approve" | "reject", or option title text ("the second one", "Sparkle") resolved server-side
}
```
Output: `{ decision: Decision; receipt?: Receipt }`

Behaviour:
- `reject` → decision `rejected`; need → `skipped` with note; agent `resume_plan`.
- choose/approve → invoke **approval executor** (§6) synchronously (≤ 8 s); then agent `resume_plan` async.
- Executor failure → `ok: false`, `UPSTREAM_UNAVAILABLE`, decision `failed`, need `blocked`.

### 3.5 `list_actions`

| | |
|---|---|
| Description | Use when the customer asks what Butler did, what it bought, what it was blocked from doing, or what they might disagree with. Returns up to five actions, most relevant first. |
| Annotations | `readOnlyHint: true` |
| View | `ui://butler/actions` |

Input:
```ts
{
  period?: "today" | "this_week" | "plan";    // default "this_week"
  filter?: "all" | "purchases" | "might_disagree" | "blocked";   // default "all"
  plan_id?: string;                            // required when period = "plan" (default latest)
}
```
Output: `{ actions: Receipt[]; total_count: number; filter: string; period: string }`

Ranking: `might_disagree` → by `might_disagree.score` desc, only score ≥ 0.3. Others → newest first. `blocked` includes `held_for_approval` and `blocked`.

### 3.6 `explain_action`

| | |
|---|---|
| Description | Use when the customer asks why Butler did something, or wants details about a specific action, purchase, message or booking. |
| Annotations | `readOnlyHint: true` |
| View | `ui://butler/receipt` |

Input: `{ action_id?: string; reference?: string }` — one required. `reference` ("the drinks", "the email to Tolu") is resolved against the last 50 receipts by title, need label, tool, recipient names and item names; if > 1 strong match → `AMBIGUOUS_REFERENCE` with up to 3 `candidates`.

Output: `{ receipt: Receipt }`

Spoken example: "I bought drinks for 42 dollars because six guests are coming. A cheaper option arrived Saturday, too late. Your 50 dollar limit allowed it."

### 3.7 `object_to_action`

| | |
|---|---|
| Description | Use when the customer disagrees with something Butler did or tells Butler how it should behave from now on, such as asking first, never doing something, or spending limits. Proposes a rule and asks the customer to confirm. |
| Annotations | `readOnlyHint: false` |
| View | `ui://butler/rule` |

Input: `{ correction: string; action_id?: string; reference?: string; confirm?: boolean }`

Two-step flow (works without elicitation):
1. First call (`confirm` absent/false): invoke agent `draft_rule` (§5). Store Rule with `policy_status: "draft"`. Return `{ rule: Rule; needs_confirmation: true }`. Spoken: "From now on, I'll ask before buying drinks. Should I make that a rule?"
2. Customer says yes → Alexa calls again with `confirm: true` and the same correction (server matches the latest draft for this household within 10 min) **or** `answer_decision` is NOT used for this. Server invokes `apply_rule` (§5), returns `{ rule: Rule; needs_confirmation: false; offered_undo?: { action_id: string; summary: string } }`.
3. If S-2 proves elicitation works: step 1 sends an elicitation (form, enum `["Yes, make it a rule", "No"]`, default first) and completes in one call.

Unsupported correction → `RULE_UNSUPPORTED`, spoken lists what Butler can do (§9.4).

### 3.8 `list_rules`

| | |
|---|---|
| Description | Use when the customer asks what Butler is allowed to do, what their rules are, or what limits are set. |
| Annotations | `readOnlyHint: true` |
| View | `ui://butler/rules` |

Input: `{}` · Output: `{ allowed: Rule[]; ask_first: Rule[]; never: Rule[] }` (active rules only)

Spoken: summarise counts and the two most recent corrections.

### 3.9 `change_rule`

| | |
|---|---|
| Description | Use when the customer wants to change or remove one of Butler's rules, such as raising a spending limit or removing an ask-first rule. |
| Annotations | `readOnlyHint: false` |
| View | `ui://butler/rule` |

Input: `{ rule_id?: string; reference?: string; change: string; confirm?: boolean }`

Same two-step confirm as §3.7. Removal → agent `remove_rule` (disables policy). Change → `draft_rule` with `base_rule_id`, then `apply_rule` (new policy created, old disabled, in that order so there's no gap).

### 3.10 `undo_action` (Should)

| | |
|---|---|
| Description | Use when the customer wants Butler to reverse something it did, such as cancelling a booking, refunding a purchase or removing a calendar event. |
| Annotations | `destructiveHint: true` |
| View | `ui://butler/receipt` |

Input: `{ action_id?: string; reference?: string }`. Server maps the original tool to its undo tool (`checkout→refund`, `book_service→cancel_booking`, `create_event→delete_event`; `send_email` is not reversible) and runs it via the **approval executor** (the customer asked, so it's approved). Output `{ original: Receipt; undo: Receipt }` or `NOT_REVERSIBLE`.

### 3.11 App-only helper tools (visibility `["app"]`)

Called by views, hidden from the model (`_meta.ui.visibility: ["app"]`):

| Tool | Input | Output | Used by |
|---|---|---|---|
| `get_ledger_page` | `{ cursor?: string; filter?: string; limit?: 1..20 }` | `{ actions: Receipt[]; next_cursor?: string }` | fullscreen ledger |
| `get_plan` | `{ plan_id }` | `{ plan: Plan }` | plan view refresh |

---

## 4. MCP Apps views [Head C]

Built with `@modelcontextprotocol/ext-apps` (`App` + `PostMessageTransport`), bundled to **one self-contained HTML file per view** (Vite + single-file plugin), served as resources with `mimeType: RESOURCE_MIME_TYPE` (`text/html;profile=mcp-app`). No external network calls from views (CSP default); images are inlined or `data:` URIs.

| URI | Layout (Amazon pattern) | Renders | Buttons → server tool |
|---|---|---|---|
| `ui://butler/plan` | List | Title, date, needs with status chips; `needs_you` pinned on top; "Simulated" badges | "Answer" → opens options (calls `get_status`), "Details" on a need → `explain_action` for its latest receipt |
| `ui://butler/options` | Carousel (3–5) | Question header; option cards (title, subtitle, price, trade-off) | "Choose" → `answer_decision {decision_id, choice: option_id}` |
| `ui://butler/receipt` | Card | Title, amount, top reason, rule badge `ALLOWED by …` / `HELD by …` / `BLOCKED by …`, alternatives (collapsed) | "Why?" → expands; "Undo" (if reversible) → `undo_action` |
| `ui://butler/actions` | Carousel inline; fullscreen ledger | Ranked receipts with one-line reason | Card tap → `explain_action`; "See more" → request fullscreen + `get_ledger_page` |
| `ui://butler/rule` | Card | Rule text, effect chip, origin line ("From your correction on 16 Oct"), status (`Draft — say yes to confirm` / `Active`) | "Confirm" → `object_to_action {confirm:true}`; "Remove" → `change_rule` |
| `ui://butler/rules` | List | Grouped Allowed / Ask first / Never | Row tap → `change_rule` prompt |

Display rules (from Amazon's Alexa+ design guide):
- Far-field legibility: base body 24px on Show 8, type scale ratio 1.6 (24 → 38 → 61). One title, ≤ 2 supporting fields, one primary action per card.
- Inline by default. Only the ledger requests fullscreen, and only via a button.
- Carousel: 3–5 items, strongest first. Render the first item immediately from `structuredContent` (no extra fetch) to meet the 500 ms first-item budget.
- Dark theme default; respect host theme from `hostContext` if provided.
- Every view must also be meaningful from `spoken_summary` alone (voice-only devices).

Design tokens live in `server/ui/tokens.css` and are shared by all views.

---

## 5. Agent runtime operations [Head B]

The Butler agent is an AgentCore Runtime (HTTP protocol: `POST /invocations`, `GET /ping`, port 8080, linux/arm64 container). The MCP server invokes it with the AWS SDK `InvokeAgentRuntime` (SigV4, server execution role).

- `runtimeSessionId`: must be ≥ 33 chars. Use `butler-${plan_id}` padded/extended as needed (plan ULIDs make it 37+). Rule ops use `butler-rules-${household_id}-${ulid}`.
- Envelope request: `{ op: string; household_id: string; correlation_id: string; ...op fields }`
- Envelope response: `{ ok: boolean; data?: object; error?: { code: string; message: string } }`

| op | Mode | Request fields | Response `data` | Notes |
|---|---|---|---|---|
| `start_plan` | **async**: returns `{accepted:true}` in < 1 s, work continues as a background task (AgentCore async task / ping `HealthyBusy`) | `plan_id` | `{ accepted: true }` | Loads plan, runs the execution loop (§5.1) until all needs are `done`, `needs_you`, `blocked` or `skipped`, or 25 tool steps |
| `resume_plan` | async | `plan_id`, `decision_id` | `{ accepted: true }` | Continue after a decision; re-plan the affected need |
| `draft_rule` | sync ≤ 6 s | `correction`, `action_id?`, `base_rule_id?` | `{ draft: RuleDraft; rule: Rule }` (rule stored as `draft`) | Model → `RuleDraft` (structured output) → validate params against template schema → compile Cedar → store. Low confidence or unsupported → `error.code = RULE_UNSUPPORTED` |
| `apply_rule` | sync ≤ 60 s (poll policy to ACTIVE) | `rule_id` | `{ rule: Rule }` | `create_policy` → wait ACTIVE → set `policy_status: active`, `active: true`; if replacing, then disable old. On timeout return `POLICY_PROPAGATING` with rule `creating`; server tells the customer "It'll be active in a moment" |
| `remove_rule` | sync ≤ 30 s | `rule_id` | `{ rule: Rule }` | `delete_policy` (or disable) → `active: false` |

### 5.1 Execution loop (inside `start_plan` / `resume_plan`)

The Strands agent gets:

**Gateway tools** (MCP client to AgentCore Gateway with the `butler-agent` token) — §7. Every call goes through the action-call wrapper (§8), which the agent sees as a normal tool whose result may say `DENIED`.

**Local tools** (Python functions in the agent process, not via Gateway, not side-effecting outside DynamoDB):

| Local tool | Input | Effect |
|---|---|---|
| `get_household` | — | household, members, contacts (no emails exposed to model beyond what tools need; model refers to contacts by `contact_id`) |
| `get_plan` | — | current plan + needs |
| `list_rules` | — | active rules as plain text + effect (so the agent avoids obviously denied actions, but enforcement never depends on it) |
| `update_need` | `need_id, status, note?` | updates need |
| `request_decision` | `need_id, kind, question, options[{title, subtitle?, price?, tradeoff, action_draft?}], default_index?, reason_held?` | creates Decision, sets need `needs_you` |
| `get_preferences` | `keys?` | household preferences |
| `note_preference` | `key, value, evidence` | (Should, A-10) |
| `finish` | `summary` | ends loop |

Loop rules (system prompt §12.2 enforces; code enforces the hard ones):
1. Work need by need; mark each `done`, `needs_you`, `blocked` or `skipped` with a note.
2. **On `DENIED` from the wrapper:** if the matched rule is `ask_first` → call `request_decision(kind: "approve_action", options: [the denied action as action_draft])`; if `never` → mark the need `skipped` with note "Not allowed by your rule: …". The agent must not retry a denied action with different args to dodge a rule (code: wrapper blocks a second call to the same tool for the same need within the run after a DENY and returns `DENIED_RETRY_BLOCKED`).
3. Services always go through `request_decision(kind: "choose_option")` with 2–3 options from `Services___search_providers`.
4. Purchases: search first, compare up to 3 options, pick, then `Supplies___checkout`. Record alternatives in the call's `reasoning` field (§8).
5. Hard cap: 25 Gateway calls per run, 120 s wall clock per run; on cap → mark remaining needs `blocked` with note "Ran out of time; ask me to try again."

---

## 6. Approval executor [Head B]

A separate Lambda (`butler-approval-executor`), invoked by the MCP server with SigV4 (`lambda:InvokeFunction`). It is **deterministic, no model calls**. It holds the `approval-executor` Cognito client secret; nothing else does.

Request:
```ts
{ household_id: string; correlation_id: string;
  mode: "decision";  decision_id: string; option_id: string }
| { household_id: string; correlation_id: string;
  mode: "undo"; action_id: string }
```
Behaviour (`decision`):
1. Load decision; require `status = "pending"`; option must exist and carry `action_draft`.
2. Conditional update decision → `approved` (prevents double execution).
3. Call Gateway tool `action_draft.tool` with `action_draft.args` as principal `approval-executor`, via the same wrapper (§8) with `decision_id` set.
4. Decision → `executed` with `result_action_id`, or `failed`.
5. Need → `done` (or `blocked` on failure).

Response: `{ ok: true, data: { decision: Decision; receipt: Receipt } }` or `{ ok: false, error }`.

Note: `never` rules forbid **both** principals, so even an approved action is denied if a `never` rule covers it. The executor returns `BLOCKED_BY_NEVER_RULE`.

---

## 7. Gateway action tools [Head B implements; Head A registers]

AgentCore Gateway exposes Lambda targets as MCP tools named `<Target>___<tool>`. Cedar actions are `AgentCore::Action::"<Target>___<tool>"`. Inline tool schemas are registered from `contracts/actions/*.json` (generated from this section).

Each Lambda reads the tool name from `context.client_context.custom["bedrockAgentCoreToolName"]` (split on `___`) and the arguments from `event`.

**Every action tool input also includes** (omitted below for brevity):
```ts
{ plan_id?: string; need_id?: string; idempotency_key: string; correlation_id: string; reasoning?: Reasoning }
type Reasoning = { reasons: string[]; context_used: string[]; alternatives: { option: string; rejected_because: string }[]; confidence?: number };
```
`reasoning` is ignored by the Lambda and copied into the receipt by the wrapper.

**Lambdas re-validate every policy-relevant field** because Cedar trusts the input: e.g. `checkout` recomputes `amount_minor` from SKUs and rejects a mismatch; `category` must equal the catalogue category of every SKU; `update_event` fetches the event and rejects if `event_owner` doesn't match the event's `extendedProperties.private.butler_owner`. A Lambda validation failure returns `INVALID_INPUT` (not DENY).

| Target | Tool | Input (besides common fields) | Output | Policy-relevant fields | Real/Sim |
|---|---|---|---|---|---|
| `Messages` | `send_email` | `recipient_contact_ids?: string[]` **or** `recipient_email?: string`; `subject`; `body_text` (≤ 2,000 chars); `kind: "invite" \| "reminder" \| "notice" \| "other"` | `{ message_ids: string[]; sent_to: string[] }` | `recipient_email` (present = non-contact), `recipient_contact_ids` | Real (SES) |
| `Calendar` | `list_events` | `from`, `to` | `{ events: {event_id, title, start, end, butler_owner: "butler" \| "human"}[] }` | — | Real (Google) |
| `Calendar` | `create_event` | `title`, `start`, `end`, `attendee_contact_ids?`, `location?`, `description?` | `{ event_id, html_link }` | — | Real |
| `Calendar` | `update_event` | `event_id`, `event_owner: "butler" \| "human"`, `title?`, `start?`, `end?` | `{ event_id }` | `event_owner` | Real |
| `Calendar` | `delete_event` | `event_id`, `event_owner` | `{ deleted: true }` | `event_owner` | Real |
| `Supplies` | `search_products` | `query`, `category?`, `deliver_by?`, `max_results?` (≤ 5) | `{ products: {sku, name, merchant, category, unit_price_minor, currency, delivery_eta, simulated: true}[] }` | — | Sim catalogue |
| `Supplies` | `checkout` | `merchant`, `items: {sku, qty}[]`, `amount_minor`, `currency`, `category`, `deliver_by?` | `{ order_id, payment_ref, amount_minor, eta, simulated_merchant: true, payment_mode: "test" }` | `amount_minor`, `category` | Test-mode payment, sim merchant |
| `Supplies` | `refund` | `order_id` | `{ refund_ref, amount_minor }` | `amount_minor` (= order total) | Test-mode |
| `Services` | `search_providers` | `service_type: "cleaning" \| "ride" \| "repair" \| "pet_care"`, `date`, `window?` | `{ providers: {provider_id, name, rating, price_minor, currency, slot_start, simulated: true}[] }` | — | Sim |
| `Services` | `book_service` | `provider_id`, `service_type`, `slot_start`, `amount_minor`, `currency` | `{ booking_id, confirmation_code, simulated: true }` | `service_type`, `amount_minor` | Sim |
| `Services` | `cancel_booking` | `booking_id` | `{ cancelled: true }` | — | Sim |
| `Context` | `get_weather` | `date`, `lat?`, `lon?` (default household location) | `{ summary, high_c, low_c, precip_prob }` | — | Real (Open-Meteo) |

Product categories (enum): `groceries`, `drinks`, `household`, `toiletries`, `gifts`, `other`.

Lambda response: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Records of external effects are written to DynamoDB (`ORDER#`, `BOOKING#`, `EVENT#`) for undo.

---

## 8. Action-call wrapper and receipts [Head B]

Python module `butler_actions.call_action` used by **both** the agent (as `butler-agent`) and the approval executor (as `approval-executor`):

```python
def call_action(principal: PrincipalName, tool: str, args: dict, *,
                household_id: str, correlation_id: str,
                plan_id: str | None, need_id: str | None,
                decision_id: str | None) -> ActionOutcome
```
Steps:
1. Strip `reasoning` from args for the Gateway call (keep it for the receipt). Add `idempotency_key` if missing.
2. Compute the **matcher decision** locally from active rules (D7) → `rule_ids`, expected ALLOW/DENY.
3. Call Gateway `tools/call` with the principal's bearer token.
4. Classify the response: policy denial → `DENY` (exact shape captured in S-1 and encoded in `classify_gateway_response()` with tests); Lambda `ok:false` → `failed`; else `executed`.
5. `matcher_gateway_agree = (matcher == gateway)`. If false, log `PARITY_MISMATCH` at ERROR with both decisions; the receipt still records the **gateway's** decision (enforcement wins).
6. Compute `might_disagree` (§8.1) and `spoken_summary` (template per tool, §15).
7. Write the receipt (always, including DENY).
8. Return `ActionOutcome { status, receipt, data?, denied_rule?: {rule_id, rule_text, effect} }` to the agent as tool output text: `EXECUTED: …` / `DENIED by rule "<text>" (<effect>)` / `FAILED: …`.

### 8.1 `might_disagree` score (deterministic)

```
score = 0.30 * first_of_kind          # no prior executed receipt with same tool + category/service_type
      + 0.25 * near_cap               # amount ≥ 80% of the applicable spend cap
      + 0.20 * above_usual_price      # unit price ≥ 120% of median of past purchases of same category
      + 0.15 * differs_from_past      # different merchant/provider than the last 2 for same category
      + 0.10 * low_confidence         # reasoning.confidence < 0.6
top_reason = label of the largest contributing factor ("It's the first time I booked a cleaner")
```
Only executed receipts get a score; others score 0.

---

## 9. Rules, templates and Cedar [Head A]

### 9.1 Identities in Cedar
- `{{AGENT_SUB}}` = Cognito app client id of `butler-agent`
- `{{EXECUTOR_SUB}}` = Cognito app client id of `approval-executor`
- `{{GATEWAY_ARN}}` = Gateway ARN

Guard every `getTag` with `hasTag` and every `context.input.x` with `context has input && context.input has x`. **Reason:** in Cedar a policy that errors is skipped, so an unguarded `forbid` fails open.

### 9.2 Base policy (always present)
The policy engine is default-deny, so this permits both known principals; every other rule is a `forbid` layered on top (`forbid` always wins).

```cedar
@id("base-permit")
permit (principal, action, resource is AgentCore::Gateway)
when {
  principal.hasTag("sub") &&
  (principal.getTag("sub") == "{{AGENT_SUB}}" || principal.getTag("sub") == "{{EXECUTOR_SUB}}")
};
```

### 9.3 Templates

`ask_first` templates apply to the agent only (approval lets the executor through). `never` templates apply to both.

| TemplateId | Effect | Params | Cedar (agent-only clause = `principal.hasTag("sub") && principal.getTag("sub") == "{{AGENT_SUB}}"`) |
|---|---|---|---|
| `spend_cap` | ask_first above cap | `tools: ("Supplies___checkout" \| "Services___book_service")[]`, `cap_minor: int` | one `forbid` per tool: `action == AgentCore::Action::"<tool>"` when agent-only `&& context has input && context.input has amount_minor && context.input.amount_minor > <cap_minor>` |
| `ask_category` | ask_first | `category: ProductCategory` | `forbid … action == AgentCore::Action::"Supplies___checkout"` when agent-only `&& context has input && context.input has category && context.input.category == "<category>"` |
| `ask_tool` | ask_first | `tool: GatewayToolName` | `forbid … action == AgentCore::Action::"<tool>"` when agent-only |
| `ask_non_contact` | ask_first | — | `forbid … action == AgentCore::Action::"Messages___send_email"` when agent-only `&& context has input && context.input has recipient_email` |
| `never_contact` | never | `contact_id: string` | `forbid … action == AgentCore::Action::"Messages___send_email"` when `context has input && context.input has recipient_contact_ids && context.input.recipient_contact_ids.contains("<contact_id>")` |
| `protect_human_events` | never | — | `forbid … action in [AgentCore::Action::"Calendar___update_event", AgentCore::Action::"Calendar___delete_event"]` when `context has input && context.input has event_owner && context.input.event_owner == "human"` |
| `never_tool` | never | `tool: GatewayToolName` | `forbid … action == AgentCore::Action::"<tool>"` (no principal condition) |

Every compiled policy gets `@id("<rule_id>")`. Exact entity names and whether `.contains` on a list from `context.input` validates are confirmed in **S-1**; adjust templates there and update this table.

### 9.4 Default rules (seeded)

| rule_id | text | template | params |
|---|---|---|---|
| `rule_default_spend` | "Ask me before spending more than 50 dollars." | `spend_cap` | `tools: [checkout, book_service], cap_minor: 5000` |
| `rule_default_contacts` | "Ask me before messaging anyone who isn't a saved contact." | `ask_non_contact` | — |
| `rule_default_calendar` | "Never change or delete events I created." | `protect_human_events` | — |
| `rule_default_services` | "Always ask me before booking a service." | `ask_tool` | `tool: Services___book_service` |
| `rule_default_refunds` | "Ask me before refunding anything." | `ask_tool` | `tool: Supplies___refund` |

Supported corrections (spoken when unsupported): "I can make rules about spending limits, asking before a type of purchase, asking before booking services, asking before messaging new people, or never messaging a specific person."

### 9.5 Rule matcher (explanations, D7)

`butler_rules.match(rules, principal, tool, args) -> (decision, matched_rule_ids)` evaluates the same templates in Python. Parity test: for every template × a table of inputs, matcher result == Gateway result in the `dev` stage (P-6).

### 9.6 Rule compiler API (Python, `butler_rules`)
```python
compile(rule: Rule, ids: Identities) -> str                 # Cedar text
validate_params(template: TemplateId, params: dict) -> None   # raises RuleParamError
draft_to_rule(draft: RuleDraft, household_id: str) -> Rule
```

---

## 10. Data model — DynamoDB [Head A]

Single table `butler-{stage}`, on-demand, PITR on, TTL attribute `ttl`.

| Entity | PK | SK | GSI1PK | GSI1SK | Notes |
|---|---|---|---|---|---|
| Household | `HH#{hh}` | `META` | | | name, timezone, currency, location {lat, lon}, address_text (never sent to model) |
| Member | `HH#{hh}` | `MEMBER#{mem}` | | | name, email |
| Contact | `HH#{hh}` | `CONTACT#{c}` | | | §2 Contact |
| Plan | `HH#{hh}` | `PLAN#{plan}` | `HH#{hh}#PLANS` | `{updated_at}` | needs stored as separate items; `last_status_read_at` |
| Need | `PLAN#{plan}` | `NEED#{need}` | | | |
| Decision | `PLAN#{plan}` | `DEC#{dec}` | `HH#{hh}#DEC#{status}` | `{created_at}` | query pending by GSI1 |
| Receipt | `HH#{hh}` | `ACT#{act}` | `PLAN#{plan}#ACT` | `{act}` | append-only; updates only for `undone` link |
| Rule | `HH#{hh}` | `RULE#{rule}` | `HH#{hh}#RULES#{active}` | `{created_at}` | |
| Preference | `HH#{hh}` | `PREF#{key}` | | | |
| Order / Booking / Event | `HH#{hh}` | `ORDER#{id}` / `BOOKING#{id}` / `EVENT#{id}` | | | provider refs for undo |
| Idempotency | `IDEMP#{key}` | `META` | | | result JSON, `ttl` = +7 days |
| Rule draft lock | `HH#{hh}` | `DRAFT#LATEST` | | | latest draft rule_id + expiry 10 min (for `confirm:true`) |

GSI1 = `GSI1PK` / `GSI1SK`, projection ALL. DynamoDB Streams on (NEW_IMAGE) for the debug API.

---

## 11. Debug API for the Black Box panel [Head A]

Small Lambda Function URL (IAM auth off, **dev/demo only**, protected by a static bearer token in env `DEBUG_API_TOKEN`, read-only):

| Route | Response |
|---|---|
| `GET /receipts?since=<act_ulid>&limit=50` | `{ receipts: Receipt[] }` newest last |
| `GET /rules` | `{ rules: Rule[] }` incl. drafts and policy status |
| `GET /policy-events?since=<ts>` | `{ events: { at, principal, tool, decision, rule_ids, gateway_request_id }[] }` (from receipts) |

The simulator's Butler panel polls every 1 s. Not part of the MCP surface (Alexa wouldn't have it); it's the "behind the scenes" visual for the video.

---

## 12. Prompts [B and C]

Stored as files in `prompts/` with version headers; changes go through PR with an eval run (A-13).

### 12.1 Fast needs pass (server, Haiku, structured output, timeout 2.5 s)
Input: situation, `when`, household timezone, today's date, contact count, capability list.
Output JSON:
```ts
{ kind: SituationKind; title: string; starts_at?: ISODateTime; ends_at?: ISODateTime;
  needs: { label: string; capability: Capability }[] }   // 2–6 needs
```
Keyword fallback (no model): hosting → invite guests (messages), add to calendar (calendar), food and drinks (supplies), cleaning (services); away → tell people (messages), block calendar (calendar), pause/redirect supplies (supplies); running_low → check and reorder supplies (supplies).

### 12.2 Planner system prompt (agent, Sonnet) — outline
- You are Butler, acting for one household. You complete needs using tools. You never invent contacts, products, prices or providers; you only use tool results.
- Rules are enforced by the system. If an action is DENIED: ask-first → `request_decision`; never → skip with a note. Never rephrase or split an action to avoid a rule.
- Always pass `reasoning` with reasons, context_used and alternatives you actually considered.
- Prefer fewer, complete actions. Use contact ids, not emails. Write emails in a warm, brief, first-person voice signed "— sent by Butler for Paul".
- Services: always offer 2–3 options via `request_decision`.
- Update every need's status with a one-line note. Call `finish` when no need is `doing`.

### 12.3 Rule drafting prompt (agent, Sonnet, structured output → `RuleDraft`)
Given the correction, the referenced receipt (if any), the template catalogue with param schemas and examples, and the current rules: pick exactly one template or return `{ "template": "unsupported" }`. Few-shot examples for each template and for unsupported asks.

### 12.4 Simulator "Alexa brain" system prompt (Head D)
- Behave like a voice assistant host with add-ons. Route utterances containing the add-on's invocation name, or clearly about its domain, to its tools.
- Choose one tool per turn unless the customer asked for two things.
- Speak from `structuredContent.spoken_summary`, lightly adapted for flow; ≤ 2 sentences; never read IDs or JSON.
- Keep conversation history; resolve "that", "the second one", "yes" against the last turn (e.g. "yes" after a rule draft → `object_to_action {confirm:true}`).
- If a tool returns `AMBIGUOUS_REFERENCE`, ask one short clarifying question listing the candidates.

---

## 13. Simulator ↔ server expectations [Head D]

| Area | Expectation |
|---|---|
| Transport | Streamable HTTP; bearer token from Cognito `sim-client` (client credentials) when the server is on AgentCore; none for local |
| Client capabilities | Declares `elicitation` (form + url) and the MCP Apps UI extension capability |
| Tool selection | Done by the brain (§12.4) using tool names + descriptions only (no Butler-specific hacks), so it also works with other servers |
| Rendering | If result `_meta.ui.resourceUri` (or tool def) is set → fetch resource once per session, cache, render via AppBridge in a sandbox iframe on a **different origin** (e.g. `localhost:3001`) per the MCP Apps spec; else render a generic data card from `structuredContent` (mimics Alexa "hydrated" mode) |
| Voice-only | Echo Dot mode never renders a view; speaks only |
| Timing | Inspector records time to first byte and total per tool call; flags carousels whose first render exceeds 500 ms |
| Plugins | A `panels/` plugin interface: `{ id, title, mount(el, ctx) }`. The Butler Black Box panel is a plugin living in the Butler repo, loaded by URL in dev (keeps the simulator generic) |

---

## 14. Error codes

| Code | Meaning | Spoken pattern |
|---|---|---|
| `INVALID_INPUT` | schema or validation failed | "I didn't catch the details. Could you say that again with the day and time?" |
| `NOT_FOUND` | id/reference not found | "I couldn't find that one." |
| `AMBIGUOUS_REFERENCE` | several matches; `candidates` (≤ 3, `{id, label}`) | "Did you mean the drinks or the snacks?" |
| `NO_ACTIVE_PLAN` | none to report on | "You don't have anything in progress. Tell me what's coming up." |
| `DUPLICATE_PLAN` | overlapping plan exists | (see §3.2) |
| `RULE_UNSUPPORTED` | correction doesn't fit a template | §9.4 sentence |
| `POLICY_PROPAGATING` | rule created, not ACTIVE yet | "Done. It'll take effect in a moment." |
| `NOT_REVERSIBLE` | can't undo | "I can't undo an email once it's sent." |
| `BLOCKED_BY_NEVER_RULE` | approved action hits a never rule | "Your rule says never to do that, so I didn't." |
| `UPSTREAM_UNAVAILABLE` | provider/API down | "The store isn't responding right now. I'll try again when you ask." |
| `INTERNAL` | anything else | "Something went wrong on my side. Please try again." |

---

## 15. Spoken-text style rules (all `spoken_summary` and spoken errors)

Enforced by `lintSpoken()` (M-19) in tests and at runtime (log WARN on violation, never block):
- ≤ 2 sentences, ≤ 35 words; at most one question, at the end
- No markdown, bullets, pipes, emoji, URLs, IDs or JSON
- Money as words-friendly numbers: "42 dollars", "42 dollars 50" (never "$42.50")
- Times as "7 PM Friday"; dates relative when within 7 days ("tomorrow", "Friday")
- People by first name; at most 3 names, then "and 3 others"
- Lead with the outcome, then the reason
- Receipts: "<what I did> because <top reason>. <rule clause>." e.g. "Your 50 dollar limit allowed it." / "I held it because you asked me to check before buying drinks."
