# Butler — Build Handoff (start here)

This pack lets a team build Butler without needing the person who designed it in the room. Read in this order:

| # | File | What it is | Who must read it |
|---|---|---|---|
| 0 | [`../SPEC.md`](../SPEC.md) | Product spec: what Butler is, why, demo story | Everyone |
| 1 | this file | Team, decisions, milestones, how we work | Everyone |
| 2 | [`01-contracts.md`](01-contracts.md) | **Source of truth** for every interface: tool schemas, data model, agent ops, Cedar templates, receipts | Everyone; each head owns a section |
| 3 | [`02-tickets.md`](02-tickets.md) | Every ticket with owner, dependencies, estimate, acceptance criteria | Everyone |
| 4 | [`03-environment.md`](03-environment.md) | Accounts, tooling, env vars, local dev, deploy, testing | Everyone, day 1 |
| 5 | [`04-demo-and-submission.md`](04-demo-and-submission.md) | Seed data, demo runbook, recording, Devpost text, friction log | Paul + Head D |

If this pack and `SPEC.md` disagree, **this pack wins** (it's newer and reflects verified platform details). If a contract is wrong, fix it by PR to `01-contracts.md` first, then code.

---

## 1. Goal and hard deadline

Ship an Alexa+ add-on (self-hosted MCP server) plus an open-source Alexa+ simulator, and submit to the Amazon Developer Hackathon.

- **Devpost deadline:** Fri 23 Oct 2026, 12:00pm PT = **8:00pm GMT+1**
- **Our submit date:** **Thu 22 Oct 2026**. Friday is buffer only. Nothing new merges after the Mon 19 Oct code freeze except bug fixes.
- **Entries:** Alexa+ track, AWS Builder mini challenge, Open Source mini challenge, friction log bonus.

---

## 2. Team

Four build heads plus a lead. If fewer people are available, merge A+B and C+D. Tickets are written so an AI coding agent can also pick them up: each is self-contained and points to the contract sections it needs.

| Role | Owns | Primary language | Workstream prefix |
|---|---|---|---|
| **Lead / PO (Paul)** | Decisions, accounts, seed data, demo, video, Devpost submission, friction log owner | — | `SET`, `D` |
| **Head A — Platform & Policy** | AWS infra (CDK), Cognito, DynamoDB, AgentCore Gateway + Policy, rule compiler, debug API | Python + TypeScript (CDK) | `P` |
| **Head B — Agent & Actions** | Strands planner agent on AgentCore Runtime, action Lambdas (SES, Calendar, payments, sim catalog/providers), approval executor, receipts | Python | `A` |
| **Head C — MCP Server & Views** | Alexa-facing MCP server (TypeScript) on AgentCore Runtime, all 9 tools, MCP Apps views | TypeScript | `M` |
| **Head D — Simulator** | Open-source Alexa+ simulator (Next.js): MCP client, "Alexa brain", voice, MCP Apps host, inspector, Black Box panel, scripted runner | TypeScript | `X` |

Spikes (`S-*`) are owned by the head whose work depends on them most.

---

## 3. Locked decisions

Change any of these only with Paul's sign-off, recorded here.

| # | Decision | Why |
|---|---|---|
| D1 | **Alexa-facing MCP server is TypeScript** (not Python as `SPEC.md` first said) | The MCP Apps SDK (`@modelcontextprotocol/ext-apps`) has first-class TypeScript server helpers (`registerAppTool`, `registerAppResource`) and the views are TypeScript anyway |
| D2 | **Agent, action Lambdas, approval executor and rule compiler are Python** | Strands Agents, AgentCore SDK and the AgentCore samples are Python-first |
| D3 | **Region `us-east-1`** | AgentCore Runtime, Gateway and Policy availability; Alexa+ is US-first. Verify in S-1 |
| D4 | **Money is integer minor units** (`amount_minor`, cents) + ISO `currency` | Cedar has no decimals; fractional amounts would fail policy conditions |
| D5 | **Demo currency USD, household timezone `America/New_York`** | Alexa+ judges are US-based. Changeable via seed data |
| D6 | **Policy enforcement = AgentCore Policy (Cedar) at AgentCore Gateway, ENFORCE mode** | Rules enforced outside the model is the core idea |
| D7 | **Policy explanation = our own rule matcher** over `Rule` records (same templates generate Cedar) | Gateway denials don't reliably name the policy; we need "which rule" in receipts. Parity tests keep the two in sync |
| D8 | **The model never writes Cedar.** It drafts a `RuleDraft` (template + params); deterministic code compiles Cedar | Valid, explainable, safe rules |
| D9 | **Two Gateway identities**: `butler-agent` (the LLM agent) and `approval-executor` (a separate Lambda, deterministic). Distinguished in Cedar by `principal.getTag("sub")` = Cognito client id | The AI can't approve its own actions |
| D10 | **Pending decisions are the primary approval path** (answered on a later turn via `answer_decision`). MCP elicitation is a progressive enhancement, only if S-2 proves it works through AgentCore Runtime | Alexa+ is turn-based; elicitation through a stateless runtime proxy is unproven |
| D11 | **Real integrations: SES email, Google Calendar, payment provider test mode. Simulated: product catalogue, service providers** (always labelled `simulated: true` and shown as such) | Credible impact without real money or real bookings |
| D12 | **Payment provider: Stripe test mode, fallback Paystack test mode** — final pick in S-5 | Stripe may not accept a Nigeria-based sign-up |
| D13 | **Google Calendar via OAuth refresh token of a dedicated test Google account** (not a service account) | Service accounts can't invite attendees without domain-wide delegation |
| D14 | **Simulator is a separate public repo, MIT**, generic (works with any MCP server). Working name `addon-sim`. No Amazon logos; README disclaimer "not affiliated with Amazon" | Open Source mini challenge + trademark safety |
| D15 | **Butler repo is public, MIT licence** | Avoids private-repo reviewer invitations; licence must show in the GitHub About panel |
| D16 | **Models via env vars**: fast model (needs pass, simulator brain) = Claude Haiku 4.5 on Bedrock; planner + rule drafting = latest Claude Sonnet available on Bedrock in `us-east-1` | Swappable without code changes |
| D17 | **One household in the demo** (`hh_demo`), resolved from the caller's token | Multi-household is out of scope |
| D18 | **Infra: CDK (TypeScript) for standard AWS resources; AgentCore Runtime/Gateway/Policy via the AgentCore CLI or starter toolkit, scripted and committed** | Confirm CloudFormation coverage for AgentCore in S-1; fall back to scripts |

---

## 4. Milestones and gates

Each gate has a demo-able check. If a gate slips by more than one day, Paul cuts scope using the **Should/Won't** lists in `SPEC.md` §3 and the cut list below.

| Gate | Date (EOD GMT+1) | Must be true |
|---|---|---|
| **G0 Spikes done** | Wed 7 Oct | S-1…S-6 written up in `handoff/spikes/`; D3, D10, D12, D18 confirmed or revised |
| **G1 Walking skeleton** | Sat 10 Oct | In the simulator: "tell Butler six people are coming Friday" → `handle_situation` returns a plan → agent sends **one real email** through Gateway → receipt stored → "how's Friday looking?" shows it done |
| **G2 Trust loop** | Wed 14 Oct | An ask-first DENY becomes a pending decision → approved → executor runs it → receipt. A correction creates a rule → policy ACTIVE → the same action is DENIED next time |
| **G3 Feature complete** | Sat 17 Oct | All **Must** tickets merged; all 6 views render in Echo Show frames; voice-only mode works |
| **G4 Deployed + freeze** | Mon 19 Oct | Everything runs in the `demo` stage on AWS; simulator published; golden demo script passes 3 times in a row |
| **G5 Recorded** | Wed 21 Oct | Final video uploaded (unlisted until submit); Devpost draft complete |
| **G6 Submitted** | Thu 22 Oct | Submitted on Devpost; repo public with licence; video public |

### Critical path
`S-1 → P-1 → P-2 → P-3 → A-6 → A-9 → M-5 → X-3 → G2`

Anything on this path is top priority for review and unblocking.

### Cut list (in order, if behind)
1. MCP elicitation (M-20, X-7): keep decisions-only flow
2. Preferences learning (A-10)
3. `undo_action` (M-11)
4. Fullscreen ledger view (keep inline carousel)
5. Nova Sonic voice (stay with browser speech + Polly)
6. Away situation rehearsal (keep Hosting + Running low; demo scene 5 uses the parents-staying variant of Hosting)

Never cut: real email, policy DENY on camera, receipts, correction → rule.

---

## 5. How we work

- **Board:** GitHub Projects on the `butler` repo, one card per ticket in `02-tickets.md`, columns Backlog / Ready / In progress / Review / Done.
- **Branches:** `main` is always deployable to `dev`. Branch per ticket: `p-3-policy-defaults`. Squash merge.
- **Reviews:** one approval; contract changes need approval from the heads on both sides of the interface. Review within 4 working hours.
- **Contracts first:** a change to any shape in `01-contracts.md` lands as its own PR before the code that depends on it. Generated types (`packages/contracts`) are rebuilt in the same PR.
- **Standup:** async, daily by 10:00 GMT+1 in the team channel: done / next / blocked.
- **Friction log:** every head adds at least one entry per working day to `docs/friction-log.md` (template in `04-demo-and-submission.md`). This is worth up to 10% of the score.
- **Product feedback notes:** keep `docs/product-feedback.md` running per tool as you use it. Don't reconstruct it at the end.
- **Definition of done (every ticket):**
  1. Acceptance criteria met and demonstrated (screenshot, log or test output in the PR)
  2. Tests added per the ticket's test notes; CI green
  3. Contract-conformant (validated against schemas where applicable)
  4. No secrets in code; config via env vars listed in `03-environment.md`
  5. Friction/feedback entries added if anything was painful
- **Cost guard:** AWS budget alarm at $50 and $100. Tear down `dev` load-heavy resources nightly if idle (see `03-environment.md`).

---

## 6. Day-1 checklist (Tue 6 Oct)

| Owner | Task |
|---|---|
| Paul | Resolve AWS account balance with AWS Support; enable Bedrock model access (Haiku 4.5, Sonnet) in `us-east-1`; set budgets (SET-1) |
| Paul | Create repos, board, invite heads (SET-2); test accounts (SET-3) |
| Paul | Office hours 6:30pm GMT+1: ask the four questions in `SPEC.md` §15 and post answers in the channel |
| Head A | Start S-1 (Policy end-to-end) |
| Head B | Start S-3 (agent on Runtime) and S-6 (Calendar + SES) |
| Head C | Start S-2 (TS MCP server on Runtime + MCP Apps + elicitation) |
| Head D | Start S-4 (MCP Apps host in Next.js) |
| Everyone | Read `SPEC.md`, this file, and your sections of `01-contracts.md`; set up tooling per `03-environment.md` |
