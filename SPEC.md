# Butler — Spec

**An Alexa+ add-on that acts on your behalf, keeps a receipt for every action, and turns your corrections into rules it cannot break.**

| | |
|---|---|
| Hackathon | Build, Ship, Shape: Amazon Developer Hackathon |
| Primary track | Alexa+ (self-hosted MCP server, spec 2025-11-25, Streamable HTTP) |
| Mini challenges | AWS Builder (Bedrock, AgentCore, Strands); Open Source (the Alexa+ simulator, separate repo) |
| Deadline | Fri 23 Oct 2026, 8:00pm GMT+1. Internal target: submit Thu 22 Oct |
| Status | Draft v1, 5 Oct 2026 |
| Working name | "Butler" (placeholder; check the invocation name isn't taken) |
| Build handoff | [`handoff/README.md`](handoff/README.md): decisions, contracts, tickets. **Where they differ from this spec, the handoff wins.** |

---

## 1. The idea in one paragraph

You tell Butler a situation, not a command: *"Guests are coming Friday."* *"I'm travelling next week."* *"We're running low on supplies."* Butler works out what that situation needs, does what it is allowed to do, and saves the rest as questions for you. Every action leaves a **receipt**: what it did, why, what it rejected, and which rule allowed it. When you object (*"don't buy drinks without asking me"*), Butler turns the objection into a **rule enforced outside the AI model**, so the next time it tries, the action is blocked and Butler asks instead.

**Pitch line:** *Alexa can act for you without being a black box.*

### Why it belongs on Alexa+
- Saying a situation out loud takes 3 seconds; doing the same in five apps takes 20 minutes.
- Alexa sits in the shared space of the home, so the household sees the same plan and receipts.
- Amazon's design guide asks add-ons to finish tasks end to end inside the conversation. Butler's whole job is finishing things.

### What makes it non-obvious (for the "Quality of the Idea" score)
The rubric lists these as creative for Alexa+; Butler does all of them:
- agentic workflow that coordinates several services on its own
- state kept across sessions (plans, receipts, rules, preferences)
- purchasing
- cards and carousels via MCP Apps

The actual invention is the **trust loop**: act → receipt → objection → enforced rule → different behaviour next time.

---

## 2. Constraints from the platform (design around these)

From the Alexa+ MCP design guide and client lifecycle docs on developer.amazon.com:

1. **Turn-based, customer-initiated.** Alexa calls the add-on when the customer speaks. Butler cannot interrupt. Background work happens on our server; results surface on the next turn (*"How's Friday looking?"*).
2. **Alexa is the MCP client.** It chooses tools from the customer's words using tool names and descriptions, and builds its spoken reply from the data we return. We can't script what Alexa says; we shape it through `structuredContent`.
3. **Screens via MCP Apps.** A tool result with `_meta.ui.resourceUri` (`ui://…`) gets our HTML rendered inline (default) or fullscreen. No UI means Alexa renders the data natively.
4. **Only four layouts:** List, Carousel (3–5 items inline, first item within 500ms), Card, Map. Don't invent others.
5. **Voice-only must work.** Every response must make sense with no screen: no markdown, pipes or tables in text.
6. **One tool per customer intent.** No overlapping tools. Declare only parameters we actually honour.
7. **Never return empty.** Always return data or an explicit, explainable error.
8. **Gated tools are unavailable.** The official Alexa+ MCP Toolkit, CLI and Web Simulator aren't open to participants, so we build our own simulator (section 9).

From the hackathon rules:
- The repo must actually run the MCP server: imports and calls in code, not just a README mention.
- Demo video under 3 minutes, showing it working in our simulator.
- Product feedback for every tool and SDK used is required. A friction log earns up to a 10% bonus.

---

## 3. Scope

### What Butler can do (capabilities)

| Capability | Example actions | Real or simulated in the demo |
|---|---|---|
| **Messages** | invite guests, remind people, tell someone you're away | **Real**: Amazon SES email (verified addresses in SES sandbox) |
| **Calendar** | create, move or block events; spot clashes | **Real**: Google Calendar API on a test calendar |
| **Supplies** | build a basket, reorder household items, buy within limits | **Real payment in test mode** (Stripe or Paystack test mode, see risks); product catalogue simulated |
| **Services** | book a cleaner, ride or repair visit | **Simulated** providers, clearly labelled in the UI |
| **Context** | weather, travel days, who is involved | **Real**: Open-Meteo weather API; contacts stored in Butler |

### Situations the demo supports
1. **Hosting** — "Six people are coming over Friday evening."
2. **Away** — "I'm travelling to Accra Thursday to Sunday."
3. **Running low** — "We're running low on household supplies."

Any other situation gets a best-effort plan using the same capabilities; it just isn't rehearsed for the demo.

### Must / Should / Won't

**Must (demo depends on it)**
- Alexa-facing MCP server with the tools in section 5
- Planner agent that turns a situation into needs and actions
- Every action routed through AgentCore Gateway with Cedar policy checks
- Receipts stored for every attempted action, allowed or denied
- Objection → new Cedar rule → visibly different behaviour next time
- Pending decisions answered on a later turn
- Simulator with voice, Echo Show frame, MCP Apps rendering, voice-only toggle, live policy panel
- The three real integrations: SES, Google Calendar, test-mode payment

**Should**
- "What did you do this week that I might disagree with?" ranking
- Undo for reversible actions (cancel a sent calendar event, refund a test payment)
- Preferences learned from past plans ("you usually order from X")
- Deployed to AgentCore Runtime (not only local) for the AWS Builder story

**Won't (this hackathon)**
- Multiple households, real account linking, real Alexa voice profiles
- Real service bookings or real money
- Proactive notifications
- Map layout

---

## 4. Architecture

```
 Simulator (Next.js)                         AWS
 ┌─────────────────────────┐
 │ Voice in/out            │   Streamable HTTP  ┌───────────────────────────┐
 │ "Alexa brain": Bedrock  │ ─────────────────▶ │ Butler MCP server         │
 │ model as MCP client     │ ◀───────────────── │ (Alexa-facing tools)      │
 │ Echo Show frame renders │   tool results +   │ AgentCore Runtime         │
 │ ui:// MCP Apps screens  │   ui:// resources  └─────────────┬─────────────┘
 │ Live Black Box panel    │                                  │ start / resume plan
 └─────────────────────────┘                                  ▼
                                               ┌───────────────────────────┐
                                               │ Butler agent (Strands)    │
                                               │ Bedrock model, planner    │
                                               │ AgentCore Runtime         │
                                               └─────────────┬─────────────┘
                                                             │ every action = tool call
                                                             ▼
                                               ┌───────────────────────────┐
                                               │ AgentCore Gateway         │
                                               │  + AgentCore Policy       │──▶ ALLOW / DENY
                                               │  (Cedar rules)            │    logged to receipt
                                               └─────────────┬─────────────┘
                                                             ▼ (if allowed)
                                  Lambda targets: send_email (SES), calendar (Google),
                                  checkout (Stripe/Paystack test), book_service (sim),
                                  search_products (sim), get_weather (Open-Meteo)

 DynamoDB: household, contacts, plans, needs, decisions, receipts, rules, preferences
```

### Components

| Component | Tech | Notes |
|---|---|---|
| Butler MCP server | TypeScript, MCP TypeScript SDK + MCP Apps SDK, Streamable HTTP, spec 2025-11-25 | Fast: returns within ~2s, hands long work to the agent (handoff decision D1) |
| Butler agent | Strands Agents (Python) on Bedrock | Plans needs, chooses actions, calls tools through the Gateway only |
| Action tools | AWS Lambda behind AgentCore Gateway (MCP targets) | Each action is one tool with explicit `amount`, `category`, `recipient` fields so Cedar can check them |
| Policy | AgentCore Policy (Cedar) | Enforced at the Gateway, outside the model. Fallback: evaluate the same `.cedar` files in our server with the open-source Cedar library |
| State | DynamoDB (single table) | Receipts are append-only |
| Hosting | AgentCore Runtime for server and agent | Infrastructure as code with AWS CDK |
| Simulator | Next.js + MCP TypeScript SDK client | Separate open-source repo (section 9) |

### Two identities (why the AI can't approve itself)
- **`butler-agent`**: the AI agent's identity at the Gateway. Policies limit it (spend caps, ask-first categories, never-do rules).
- **`approval-executor`**: used only by deterministic server code, after the customer approves a pending decision. The model never holds this credential.

So when a rule says "ask first", the agent's call is denied. Butler records a pending decision. If the customer says yes, plain code (not the model) runs the action as `approval-executor`. The AI can't fake an approval.

---

## 5. Alexa-facing MCP tools

Design rules: one intent per tool; descriptions say when to call, why, and what comes back; every response includes `spoken_summary` (one or two plain sentences, no formatting) for voice-only devices.

### 5.1 `handle_situation`
- **When:** the customer describes something coming up or a state of affairs: guests, travel, running out of things.
- **Input:** `situation` (string, required), `when` (ISO date-time or natural phrase, optional)
- **Does:** creates a plan, lists the needs it found, starts background work, returns immediately.
- **Returns:** `plan_id`, `title`, `needs[]` (`id`, `label`, `status`: `doing` · `done` · `needs_you` · `blocked` · `skipped`), `spoken_summary`
- **Screen:** List (`ui://butler/plan`)
- **Voice:** "Got it. Six guests Friday at 7. I'll handle invites, the calendar and supplies, and I'll check with you on cleaning."

### 5.2 `get_status`
- **When:** "How's Friday looking?", "What's left?", "Anything you need from me?"
- **Input:** `plan_id` (optional; defaults to the most recent active plan)
- **Returns:** plan with updated needs, `done_since_last_check[]`, `pending_decisions[]`, `spoken_summary`
- **Screen:** List (`ui://butler/plan`)

### 5.3 `answer_decision`
- **When:** the customer chooses between options Butler offered, or approves or rejects a held action.
- **Input:** `decision_id` (required), `choice` (option id or `approve` / `reject`)
- **Does:** if approved, runs the action through `approval-executor` and writes a receipt.
- **Returns:** result and receipt summary
- **Screen:** Card (`ui://butler/receipt`)
- **Note:** when Alexa calls a tool with a decision already pending, the server may use MCP **elicitation** (form mode, enum options with a default) to ask in the same turn. For payments over the spend limit, use **URL-mode elicitation** to send the customer to a secure approval page (new in 2025-11-25).

### 5.4 `list_actions`
- **When:** "What did you do this week?", "What did you buy?", "What might I disagree with?"
- **Input:** `period` (`today` · `this_week` · `plan`), `filter` (`all` · `purchases` · `might_disagree` · `blocked`)
- **Returns:** up to 5 receipts, ranked, each with a one-line reason; `total_count`
- **Screen:** Carousel inline (`ui://butler/actions`), fullscreen ledger on "See more"
- **"Might disagree" score** (deterministic, explainable):
  - first time doing this kind of action
  - within 20% of a spend limit
  - price above the household's usual for that item
  - differs from a past choice
  - the agent's own low-confidence flag

### 5.5 `explain_action`
- **When:** "Why did you buy that?", "Why did you message Tolu?"
- **Input:** `action_id`, or `reference` (free text such as "the drinks"; the server resolves it against recent receipts)
- **Returns:** the full receipt (section 6)
- **Screen:** Card (`ui://butler/receipt`)
- **Voice:** "I bought drinks for 42 dollars because six guests were confirmed. A cheaper option arrived Saturday, too late. Your rule allows purchases up to 50 dollars."

### 5.6 `object_to_action`
- **When:** the customer disagrees with something Butler did, or tells it how to behave in future: "Don't do that without asking", "Never message my boss".
- **Input:** `correction` (string, required), `action_id` (optional)
- **Does:**
  1. drafts a rule (plain-language text + Cedar)
  2. confirms with the customer via elicitation: "From now on I'll ask before buying drinks. Okay?"
  3. on confirm, saves and activates the policy
  4. offers to undo the original action if it's reversible
- **Returns:** the new rule
- **Screen:** Card (`ui://butler/rule`)

### 5.7 `list_rules`
- **When:** "What are my rules?", "What are you allowed to do?"
- **Returns:** rules grouped by effect (`allowed` · `ask_first` · `never`), each with its origin (`default` or `from your correction on <date>`)
- **Screen:** List (`ui://butler/rules`)

### 5.8 `change_rule`
- **When:** "Raise my limit to 80 dollars", "Remove the drinks rule"
- **Input:** `rule_id` or `reference`, `change` (string)
- **Does:** same confirm-then-save flow as `object_to_action`
- **Screen:** Card (`ui://butler/rule`)

### 5.9 `undo_action` (Should)
- **When:** "Undo that", "Cancel the cleaner"
- **Input:** `action_id` or `reference`
- **Returns:** undo receipt, or why it can't be undone

### MCP features used (and where)
| Feature | Where |
|---|---|
| Tools with `outputSchema` + `structuredContent` | every tool |
| MCP Apps (`ui://` resources, `_meta.ui.resourceUri`) | all screens; declared on the tool and in the result `_meta` |
| Form elicitation with enum options and defaults | decisions, rule confirmation |
| URL-mode elicitation | approving payments over the limit |
| Tool icons | every tool |
| Input validation errors as tool errors | every tool, so the model can self-correct |
| Tasks (experimental, optional) | long-running plan execution, if time allows |

---

## 6. The receipt (Black Box record)

Written for **every attempted action**, including denied ones. Append-only.

```json
{
  "action_id": "act_01J…",
  "plan_id": "plan_01J…",
  "situation": "Six people are coming over Friday evening",
  "need": "Drinks for 7 people",
  "action": {
    "tool": "checkout",
    "args": { "merchant": "sim-grocer", "category": "drinks", "amount_minor": 4200, "currency": "USD", "items": ["…"] }
  },
  "status": "executed",
  "reasons": [
    "6 guests confirmed via invite replies",
    "No drinks in household supplies list"
  ],
  "context_used": ["calendar:Fri 19:00 dinner", "contacts:6 invited", "preference:usual brand"],
  "alternatives": [
    { "option": "Same items, $36", "rejected_because": "arrives Saturday, after the event" },
    { "option": "Premium bundle, $58", "rejected_because": "over the $50 auto-buy limit" }
  ],
  "authority": {
    "decision": "ALLOW",
    "principal": "butler-agent",
    "policy_ids": ["default-spend-under-50"],
    "evaluated_at": "2026-10-16T14:02:11Z",
    "gateway_request_id": "…"
  },
  "result": { "payment_ref": "pi_test_…", "eta": "Fri 12:00–14:00" },
  "reversible": true,
  "might_disagree_score": 0.62,
  "spoken_summary": "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it."
}
```

Denied actions get `"status": "held_for_approval"` or `"blocked"`, with `authority.decision: "DENY"` and the policy that denied it. That denial is what the demo's side panel shows.

---

## 7. Rules and policies

### Rule model (what the customer sees)
| Field | Example |
|---|---|
| `id` | `rule_drinks_ask` |
| `text` | "Ask me before buying drinks." |
| `effect` | `allow` · `ask_first` · `never` |
| `applies_to` | tool + conditions (category, amount, recipient, time) |
| `cedar` | the generated policy |
| `origin` | `default`, or `correction` + `action_id` + date |
| `active` | true / false |

### Default rules (first run)
1. Purchases up to $50 are allowed; above that, ask.
2. Messages only to saved contacts; anyone else, ask.
3. Calendar: may add events; may not delete or move events created by a person.
4. Services (cleaners, rides): always ask.
5. Never share the home address with someone who isn't a saved contact.

### Cedar sketch
Illustrative only. Confirm the exact entity and action names against the AgentCore Policy docs on day 1.

```cedar
// default-spend-under-50
permit (
  principal == AgentCore::OAuthUser::"butler-agent",
  action == AgentCore::Action::"Supplies___checkout",
  resource
) when { context.input.amount <= 50 };

// rule_drinks_ask (created from a correction)
forbid (
  principal == AgentCore::OAuthUser::"butler-agent",
  action == AgentCore::Action::"Supplies___checkout",
  resource
) when { context.input.category == "drinks" };

// approved actions run by deterministic code after the customer says yes
permit (
  principal == AgentCore::OAuthUser::"approval-executor",
  action,
  resource
);
```

In Cedar, `forbid` beats `permit`, so a correction always wins over a default allowance.

### Correction → rule pipeline
1. Model drafts `{text, effect, applies_to}` from the customer's words and the referenced receipt.
2. Deterministic code compiles `applies_to` into Cedar from a small set of templates (category, amount, recipient, time window). The model never writes raw Cedar; this keeps rules valid and explainable.
3. Validate the policy against the schema. If it's invalid, ask the customer to rephrase.
4. Confirm with the customer (elicitation), then activate.
5. Re-check pending plans: anything that now conflicts moves to `needs_you`.

---

## 8. Screens (MCP Apps)

All screens follow Amazon's guide: far-field legible (1.6 type scale), one title, one or two supporting fields, one clear action. Each has a voice-only fallback.

| Screen | URI | Layout | Content |
|---|---|---|---|
| Plan | `ui://butler/plan` | List | Situation title + date; needs with status chips; "Needs you" items pinned on top |
| Decision options | `ui://butler/options` | Carousel (3–5) | Option title, price/time, one-line trade-off, "Choose" button |
| Receipt | `ui://butler/receipt` | Card | What it did, amount, the deciding reason, rule badge (ALLOW/DENY), "Why?" and "Undo" buttons |
| Actions | `ui://butler/actions` | Carousel inline / fullscreen ledger | Ranked receipts; fullscreen shows a timeline with filters |
| Rule | `ui://butler/rule` | Card | Rule in plain words, origin ("from your correction on 16 Oct"), "Change" and "Remove" buttons |
| Rules | `ui://butler/rules` | List | Grouped: allowed / ask first / never |

---

## 9. Alexa+ simulator (demo surface; separate open-source repo)

Every Alexa+ entrant needs one because Amazon's Web Simulator is gated, so it doubles as the **Open Source** mini-challenge entry.

**Working name:** `alexa-plus-sim`. Licence: MIT. Works with any MCP server, not just Butler.

| Feature | Detail |
|---|---|
| MCP client | MCP TypeScript SDK over Streamable HTTP; lists tools and resources |
| "Alexa brain" | Bedrock model with tool calling; picks tools, writes the spoken reply from `structuredContent`; keeps conversation history across turns |
| Voice | Push-to-talk speech-to-text (browser Web Speech API; Nova Sonic as a stretch goal); Amazon Polly for the reply |
| Devices | Echo Show 8, Echo Show 15, Echo Dot (voice-only) frames |
| MCP Apps host | Renders `ui://` resources in a sandboxed iframe; supports inline and fullscreen; passes button presses back as tool calls |
| Elicitation | Spoken question + on-screen buttons; URL mode opens an approval page |
| Inspector panel | Live log of tool calls, results and timings (checks the 500ms first-item budget) |
| Butler add-on panel | Optional plugin showing policy ALLOW/DENY events as they happen (the demo's key visual) |

---

## 10. Data model (DynamoDB, single table)

| Entity | PK | SK | Key fields |
|---|---|---|---|
| Household | `HH#id` | `META` | name, timezone, currency |
| Contact | `HH#id` | `CONTACT#id` | name, email, relationship |
| Plan | `HH#id` | `PLAN#id` | situation, when, status, created_at |
| Need | `PLAN#id` | `NEED#id` | label, capability, status |
| Decision | `PLAN#id` | `DEC#id` | question, options[], default, status, action_draft |
| Receipt | `HH#id` | `ACT#ts#id` | section 6 (append-only) |
| Rule | `HH#id` | `RULE#id` | section 7 |
| Preference | `HH#id` | `PREF#key` | value, learned_from[] |

---

## 11. Demo script (under 3 minutes)

Split screen: simulator on the left (Echo Show 15), Black Box panel on the right.

| Time | Customer says | What's shown |
|---|---|---|
| 0:00 | (title) | "Alexa can act for you. Can you trust what it did?" |
| 0:08 | "Alexa, tell Butler six people are coming over Friday at 7." | Plan list appears; needs start ticking over |
| 0:35 | "How's Friday looking?" | Invites sent (real emails arrive on a phone on camera), calendar event created, drinks bought for $42. One decision: cleaner A (cheaper) or B (earlier) → carousel; customer picks B |
| 1:10 | "Why did you buy the drinks?" | Receipt card: reasons, two rejected options, ALLOW under "spend up to $50" |
| 1:35 | "Don't buy drinks without asking me." | Rule card: "Ask me before buying drinks", origin = this correction. Panel shows a new Cedar policy activated |
| 1:55 | "I'm travelling Thursday to Sunday. My parents are staying at the house." | New plan: messages, calendar block, supplies for guests. Agent tries to buy drinks → panel flashes **DENY (rule_drinks_ask)** → Alexa: "I'd like to get drinks for your parents, 31 dollars. Should I?" |
| 2:30 | "What did you do this week that I might disagree with?" | Ranked carousel: the cleaner choice and a near-limit purchase |
| 2:45 | (close) | Architecture slide: Alexa+ → MCP → Strands → AgentCore Gateway + Policy. "Every action has a receipt. Every correction becomes a rule." |

Rehearse with seeded data; record real API effects (emails arriving, calendar updating).

---

## 12. Judging map

| Criterion | How Butler scores |
|---|---|
| Tech implementation | MCP 2025-11-25 server with MCP Apps, elicitation (form + URL), tasks; Strands agent; policy enforced at AgentCore Gateway; real SES, Calendar and payment integrations |
| Design | Follows Amazon's four layouts and voice-only rules; one intent per tool; receipts readable from across the room |
| Potential impact | Trust is what stops people letting agents act. Shippable to the Alexa+ add-on store; the receipt + rule pattern applies to any Alexa add-on that acts on a customer's behalf |
| Quality of idea | Hits every "creative" example in the Alexa+ rubric; the correction-to-enforced-rule loop is new |
| AWS Builder | Bedrock + AgentCore (Runtime, Gateway, Policy) + Strands + DynamoDB + SES + Lambda, documented in the README and feedback |
| Open Source | `alexa-plus-sim` unblocks every other Alexa+ builder |
| Friction log bonus | Logged daily from day 1 (`docs/friction-log.md`) |

---

## 13. Repo layout

See [`handoff/03-environment.md`](handoff/03-environment.md) §1 for the full layout. In short: `butler` (public, MIT) holds the TypeScript MCP server and views, the Python agent, action Lambdas, approval executor and rule libraries, plus CDK infra; the simulator is a separate public repo, `addon-sim` (handoff decision D14).

---

## 14. Plan (6–22 Oct)

| Dates | Deliverable |
|---|---|
| **Tue 6 Oct** | Day-1 checks (section 15). Office hours 6:30pm GMT+1. Start friction log |
| 6–7 Oct | MCP server skeleton with all tools returning seeded data; DynamoDB table; receipts written |
| 8–11 Oct | Strands agent; Gateway + Lambda actions; SES, Calendar and test-mode payment working; default policies enforced |
| 12–14 Oct | Simulator: voice, Echo Show frame, MCP Apps host, voice-only toggle, inspector |
| 15–17 Oct | Receipt, actions and rule screens; correction → Cedar rule loop; "might disagree" ranking |
| 18–19 Oct | Deploy to AgentCore Runtime; README; publish `alexa-plus-sim`. Office hours #2 Mon 5pm GMT+1 |
| 20–21 Oct | Record demo, write product feedback, finish friction log |
| **Thu 22 Oct** | Submit on Devpost. Fri 23 Oct is buffer only |

---

## 15. Risks and day-1 checks

| Risk | Check / fallback |
|---|---|
| AWS account has an unpaid balance and may be suspended | Resolve with AWS Support before anything else; credits likely won't cover past bills |
| AgentCore Policy not available or not in our region | Check us-east-1 on day 1. Fallback: same `.cedar` files evaluated in our server with the open-source Cedar library (still enforced outside the model) |
| Bedrock model access | Request model access on day 1 |
| Stripe sign-up may not support a Nigeria-based account, even in test mode | Use Paystack test mode (Stripe-owned, Nigeria-native), or PayPal sandbox |
| SES sandbox only sends to verified addresses | Verify the demo recipients' addresses; enough for the demo |
| Google Calendar OAuth friction | Use a dedicated test Google account and calendar |
| Scope creep ("a butler can do anything") | Only the three rehearsed situations and the capability table in section 3 |
| Model latency breaks the 500ms first-item budget | `handle_situation` returns the needs list from a fast first pass; heavy work runs in the background |
| Judges see simulated providers as fake | Label them clearly; keep the real actions (email, calendar, payment) prominent in the video |

### Questions for office hours (Tue 6 Oct)
1. Do Alexa+ MCP add-ons support MCP Tasks or any proactive notification path?
2. Does Alexa+ currently support URL-mode elicitation from spec 2025-11-25?
3. Is a third-party add-on allowed to hold purchase authority outside Amazon's Payments for Alexa+ flow, or should purchases go through it?
4. Any guidance on presenting a self-built simulator so judges treat it as faithful to Alexa+?

---

## 16. Submission checklist
- [ ] Text description (what it does, how it works)
- [ ] GitHub repo, public with MIT licence (avoids the private-repo collaborator step) and clear setup instructions
- [ ] Demo video under 3 minutes, public on YouTube, English
- [ ] Track: Alexa+. Mini challenges: AWS Builder, Open Source
- [ ] Product feedback for every tool used (MCP SDK, Strands, Bedrock, AgentCore Runtime/Gateway/Policy, DynamoDB, SES, Lambda, CDK); AWS services described here for AWS Builder
- [ ] Open Source fields: contribution URL, repo URL, GitHub username, description
- [ ] Friction log entries (task, steps, expected vs actual, severity, workaround, suggestion)
- [ ] Optional feature requests (critical / important / nice-to-have)
