# 04 — Demo, recording and submission

Owner: Paul (with Head D for scripts and the simulator).

## 1. Seed data (D-1)

The numbers below are chosen so the demo story comes out exactly. Don't change one without re-checking the scenes in §2.

### Household (`seed/household.json`)
| Field | Value |
|---|---|
| `household_id` | `hh_demo` |
| name | "Paul's home" |
| timezone | `America/New_York` |
| currency | `USD` |
| location | lat 40.7128, lon -74.0060 (weather only) |
| member | Paul (`mem_paul`) |

### Contacts (`seed/contacts.json`)
Emails are team-controlled test inboxes verified in SES (SET-3). Use `+` aliases on one inbox so one phone shows every arrival.

| contact_id | Name | Relationship | Tags |
|---|---|---|---|
| `c_tolu` | Tolu | friend | dinner-crew |
| `c_sam` | Sam | friend | dinner-crew |
| `c_ada` | Ada | friend | dinner-crew |
| `c_chris` | Chris | friend | dinner-crew |
| `c_maya` | Maya | friend | dinner-crew |
| `c_dee` | Dee | friend | dinner-crew |
| `c_mum` | Mum | family | parents |
| `c_dad` | Dad | family | parents |
| `c_jordan` | Jordan | work | boss |

### Catalogue (`seed/catalog.json`), drinks and food that matter for the script
All merchants simulated. Delivery ETAs are relative to "now" at seed time so the story holds on any day: "Friday" means the next Friday.

| sku | name | merchant | category | price (minor) | delivery |
|---|---|---|---|---|---|
| `drk-party-7` | Drinks bundle for 7 (sodas, juice, sparkling water) | FreshCart | drinks | 4200 | Friday 12–2 PM |
| `drk-party-7-budget` | Drinks bundle for 7 | BudgetBasket | drinks | 3600 | **Saturday** |
| `drk-premium-7` | Premium drinks bundle for 7 | Corner Cellar | drinks | 5800 | Friday |
| `drk-family-3` | Drinks for a weekend, 3 people | FreshCart | drinks | 3100 | Thursday |
| `snk-party-7` | Snack platter for 7 | FreshCart | groceries | 2800 | Friday 12–2 PM |
| `grc-guest-basics` | Guest basics (bread, eggs, fruit, coffee) | FreshCart | groceries | 2400 | Thursday |
| `hh-paper-bundle` | Paper towels + toilet paper | FreshCart | household | 1900 | 2 days |
| `hh-dish-tabs` | Dishwasher tablets | FreshCart | household | 1300 | 2 days |
| … ~50 more realistic SKUs across categories for search variety | | | | | |

### Providers (`seed/providers.json`), cleaning
| provider_id | name | rating | price (minor) | slot |
|---|---|---|---|---|
| `prv_sparkle` | Sparkle Cleaners | 4.8 | 6500 | Thursday 3 PM |
| `prv_brighthome` | BrightHome | 4.9 | 8500 | Friday 10 AM |
| `prv_tidyup` | TidyUp Co | 4.5 | 5900 | Thursday 9 AM |

### History (`seed/history.json`)
Executed receipts dated 3–6 weeks ago (so "might disagree" has a baseline):
- 3 drinks purchases from FreshCart: 2800, 3000, 3300 → median 3000; the 4200 purchase is ≥ 120% of usual
- 2 household supply purchases from FreshCart
- **No** cleaning bookings → BrightHome is "first time I booked a cleaner"

### Rules
The 5 default rules from contracts §9.4. Nothing else.

## 2. Golden demo script (D-3)

Recorded on the `demo` stage after `make reset-demo`. Device: "Smart display 15". Right side: Butler Black Box panel. The phone inbox is captured separately and composited.

| # | Time | Utterance | Expected tool(s) | Must be true (asserted in YAML) |
|---|---|---|---|---|
| 1 | 0:08 | "Tell Butler six friends from the dinner crew are coming over Friday at 7." | `handle_situation` | plan kind `hosting`; needs include messages, calendar, supplies, services |
| — | wait | (until no need is `doing`, max 60 s) | — | |
| 2 | 0:35 | "How's Friday looking?" | `get_status` | 6 invites sent; calendar event exists; drinks receipt 4200 ALLOW by `rule_default_spend`; one pending `choose_option` decision for cleaning with 3 options |
| 3 | 0:55 | "Book BrightHome." | `answer_decision` | receipt principal `approval-executor`, booking simulated |
| 4 | 1:10 | "Why did you buy the drinks?" | `explain_action` | alternatives include BudgetBasket "arrives Saturday" and Corner Cellar "over your 50 dollar limit" |
| 5 | 1:35 | "Don't buy drinks without asking me." | `object_to_action` | draft rule `ask_category: drinks` |
| 6 | 1:45 | "Yes." | `object_to_action {confirm:true}` | rule active; panel shows new rule |
| 7 | 1:55 | "I'm travelling Thursday to Sunday. My parents are staying at the house." | `handle_situation` | plan kind `away`; agent attempts `checkout` category drinks → **DENY** shown in panel; decision `approve_action` with `reason_held.rule_id` = the new rule |
| — | wait | (until a decision is pending, max 60 s) | — | |
| 8 | 2:20 | "Anything you need from me?" | `get_status` | spoken asks to approve drinks for 31 dollars |
| 9 | 2:30 | "What did you do this week that I might disagree with?" | `list_actions {filter:"might_disagree"}` | BrightHome booking and the 42-dollar drinks in top results |
| 10 | 2:45 | (outro voiceover) | — | — |

YAML skeleton (`scripts/butler-golden.yaml`):
```yaml
server: butler
device: display-15
steps:
  - say: "Tell Butler six friends from the dinner crew are coming over Friday at 7."
    expect_tool: handle_situation
    expect: { "structuredContent.plan.kind": hosting }
  - wait_until: { tool: get_plan, path: "plan.needs[*].status", none_equal: doing, timeout_s: 60 }
  - say: "How's Friday looking?"
    expect_tool: get_status
    expect:
      "structuredContent.pending_decisions[0].kind": choose_option
  - say: "Book BrightHome."
    expect_tool: answer_decision
    expect: { "structuredContent.receipt.authority.principal": approval-executor }
  # … steps 4–9 as in the table
```

## 3. Recording plan (D-7)

- **Capture:** OBS, 1920×1080, 30 fps. Scene A: simulator full screen (device left, panel right). Scene B: picture-in-picture phone inbox (mirror via QuickTime/scrcpy) during step 2.
- **Audio:** Paul's voice for utterances (clear mic), Polly voice for replies (captured from the browser), short voiceover intro/outro recorded separately.
- **Edit:** cut waits (show a "working in the background…" title card, 1 s). Burned-in captions. Keep under **2:55**.
- **Opening line (0:00–0:08):** "Alexa+ can now act for you. The question is whether you can trust what it did."
- **Closing line (2:45–2:55):** architecture diagram + "Every action has a receipt. Every correction becomes a rule the AI can't break. Built on Alexa+ MCP, Strands and Amazon Bedrock AgentCore."
- **Do not include:** third-party music without a licence, real personal emails/phone numbers (blur inbox addresses), Amazon logos beyond plain text references.
- Upload to YouTube **unlisted** for team review; switch to **public** right before submitting.

## 4. Devpost submission text (D-8)

Draft in `docs/devpost.md`; paste into Devpost on Thursday.

### Title
Butler — an Alexa+ add-on that acts for you, shows its receipts, and learns rules it can't break

### Tagline (≤ 200 chars)
Tell Alexa what's happening. Butler handles it, explains every action, and turns your corrections into rules enforced outside the AI.

### Description sections
1. **What it does:** situations in, outcomes out; receipts; corrections → enforced rules (with the demo story).
2. **How we built it:** Alexa+ MCP server (TypeScript, MCP 2025-11-25, MCP Apps views), Strands planner on Bedrock AgentCore Runtime, actions through AgentCore Gateway with AgentCore Policy (Cedar), approval executor, DynamoDB, SES, Google Calendar, test-mode payments; open-source simulator because Alexa+ tools are gated.
3. **Built for Alexa+:** turn-based design, pending decisions, voice-only summaries, Amazon's four layouts.
4. **Challenges:** honest list (pull from the friction log).
5. **What's next:** Payments for Alexa+, account linking, more templates, household members with different authority.
6. **Simulated vs real:** a clear table (be upfront; judges value it).

### Required fields
- **Track:** Alexa+. **Mini challenges:** AWS Builder, Open Source.
- **Repo:** `https://github.com/<org>/butler` (public, MIT).
- **Video:** YouTube link.
- **Product feedback:** one block per tool (template below). Include AWS services used and how (required for AWS Builder).
- **Open Source:** contribution URL (`addon-sim` repo), project repo URL, GitHub username, what/how/why (X-13).
- **Existing project?** No, new during the submission window.
- **Optional:** feature requests (template below), friction log (link + pasted top entries).

## 5. Templates

### Product feedback (`docs/product-feedback.md`), one block per tool
```markdown
### <Tool / API / SDK name and version>
- **Used for:** 
- **What worked well:** (setup, docs, testing, performance, reliability)
- **What needs work:** (errors, doc sections, missing features, compatibility, workarounds)
- **Onboarding (zero to hello world):** time taken, blockers
- **Would build with it again?** Yes/No, because…
```
Cover at least: Alexa+ MCP design guide/docs, MCP TypeScript SDK, MCP Apps SDK (ext-apps), Strands Agents, Bedrock (Converse), AgentCore Runtime, AgentCore Gateway, AgentCore Policy, AgentCore CLI/starter toolkit, DynamoDB, SES, Lambda, Cognito, CDK, Polly.

### Friction log entry (`docs/friction-log.md`)
```markdown
### FL-<nn> · <short title> · <date> · <who>
- **Tool:** 
- **Task attempted:** 
- **Steps taken:** 1. … 2. …
- **Expected:** 
- **Actual:** (error text verbatim)
- **Severity:** blocker / major / minor
- **Workaround:** 
- **Suggestion:** (specific and actionable)
```
Aim for 15–25 good entries by submission. Specific beats many.

### Feature request
```markdown
### FR-<nn> · <title>
- **Description:** 
- **Why it matters for this project:** 
- **Priority:** Critical / Important / Nice-to-have
```
Likely candidates to log as they happen: open Alexa+ Web Simulator access for hackathons; proactive notifications for MCP add-ons; policy decision ids in Gateway denial responses; faster policy propagation; Cedar decimal support.

## 6. Final submission checklist (D-9)

- [ ] Repo public, MIT licence visible in GitHub About, README with setup + links to the MCP server entry point
- [ ] `addon-sim` public, MIT, README, release tag
- [ ] Video ≤ 3:00, public, English, shows it running in the simulator
- [ ] Track + both mini challenges selected
- [ ] Product feedback for every tool, AWS services described
- [ ] Open Source fields complete
- [ ] Friction log attached/linked
- [ ] Text description proofread
- [ ] Submitted **Thu 22 Oct**; confirmation screenshot saved
