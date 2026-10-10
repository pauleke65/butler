# Devpost submission (draft)

Paste-ready text for the Devpost form. Checked against the deployed `dev` stack on 2026-10-10.

---

## Project name
Butler

## Tagline (≤ 200 characters)
Tell Alexa what's happening. Butler handles it, keeps a receipt for every action, and turns your corrections into rules enforced outside the AI.

## Inspiration
Alexa+ can now act for you: book, buy, message. That's useful only if you can trust what it did. Today an agent's actions are a black box. You can't see why it chose something, and "please don't do that again" is just more text in a prompt the model may or may not follow. We wanted an assistant whose actions you can audit, and whose limits are enforced by the system rather than promised by the model.

## What it does
- **Situations, not commands.** "Six friends from the dinner crew are coming over Friday at 7." Butler works out the needs (invites, calendar, drinks, a cleaner) and handles what it's allowed to, in the background.
- **It asks only when it should.** It doesn't interrupt (Alexa+ is turn-based); the next time you ask "How's Friday looking?", it tells you what's done and asks the one question it needs: which cleaner to book.
- **Every action has a receipt:** what it did, why, the options it rejected ("BudgetBasket arrives Saturday, after the party"; "Corner Cellar is over your 50 dollar limit"), and which rule allowed it.
- **Corrections become rules.** "Don't buy drinks without asking me" becomes a policy. The next time Butler tries to buy drinks, the gateway denies the call before anything is bought, and Butler asks you instead.
- **"What did you do this week that I might disagree with?"** ranks its own actions: first-time bookings, purchases near your limit, prices above your usual.

## How we built it
- **Alexa+ add-on:** a self-hosted MCP server in TypeScript (official MCP SDK, stateless Streamable HTTP, negotiates spec **2025-11-25**) with 9 tools designed from Amazon's Alexa+ MCP design guide: one tool per intent, voice-only `spoken_summary`, never an empty result. Six **MCP Apps** screens (`ui://`) using the guide's List, Carousel and Card layouts.
- **Planner agent** on **AgentCore Runtime** turns a situation into needs and actions; every action goes through **Amazon Bedrock AgentCore Gateway**. It is written as a tool-use loop for **Amazon Bedrock** with **Amazon Nova 2 Lite**. Our new account still has zero Bedrock quota, so the deployed stack and the demo run the planner's deterministic offline twin; the Bedrock path is implemented and tested, but has not run against the live model yet.
- **Rules enforced outside the model:** **AgentCore Policy** evaluates Cedar policies on every tool call. The model never writes Cedar: it picks one of seven rule templates; deterministic code validates the parameters, compiles the policy, activates it, and waits for it to take effect before telling you "done".
- **The AI can't approve itself:** two Cognito machine identities. "Ask first" rules block only the agent. Your "yes" is executed by a separate deterministic approval executor (a Lambda with no model) under its own identity; "never" rules block both.
- **Receipts:** a wrapper around every gateway call records the gateway's decision, the rule that allowed or denied it, the reasoning and the alternatives, then writes it to **DynamoDB**.
- **Infrastructure as code:** one AWS CDK stack (AgentCore Runtime for the MCP server and the agent, Gateway with five tool targets served by one Lambda, Policy engine in ENFORCE mode, Cognito, DynamoDB). The demo video runs against this deployed stack.
- **Open-source simulator:** the official Alexa+ simulator isn't available to participants, so we built **addon-sim**: a generic MCP Apps host with smart-display frames, voice, an inspector and a scripted-conversation runner. Butler's demo runs in it; it works with any MCP server.

## Challenges we ran into
- **Rules that fail open.** In Cedar, a policy that errors is skipped. An unguarded "forbid checkout over 50 dollars" silently allows the call when the amount is missing or the wrong type. We reproduced it with the real Cedar engine, then guarded every rule, type-checked inputs before the call (fail closed), and had each tool re-validate its own inputs.
- **"Active" isn't "enforced".** Our first end-to-end run showed a just-created rule not blocking the very next purchase. Rule changes now wait for the policy to take effect before Butler confirms.
- **No model on day one.** Our new AWS account had zero Bedrock quota, so every model-backed step got a deterministic offline twin. That made the whole system testable without models, and the demo reproducible.
- **Stateless MCP servers can't elicit.** A per-request server never sees `initialize`, so in-call confirmations failed; we use an explicit two-step confirmation instead.
- Details in our friction log (linked below).

## Accomplishments that we're proud of
- An end-to-end trust loop that works: act → receipt → objection → enforced rule → different behaviour next time, with the denial visible as it happens.
- A parity test that runs our Python rule matcher against the real Cedar engine across about a thousand cases (every template, both identities, edge amounts, missing and mistyped fields) with zero disagreements.
- Over 700 automated tests, and a scripted 13-step golden demo that runs headless against the real stack.
- An open-source simulator other Alexa+ builders can use today.

## What we learned
- Agent safety is easiest to reason about when enforcement sits outside the model and the model's job is reduced to choosing among validated templates.
- Designing for a turn-based voice surface changes the product: no notifications, so pending decisions and "anything you need from me?" become the core loop.
- Writing the offline twin first made everything else faster.

## What's next for Butler
- Payments through Alexa+'s own checkout instead of a test-mode provider.
- Account linking and household members with different authority (a teenager's spending limit).
- More rule templates (time windows, per-merchant limits) and rule suggestions mined from the receipts.

## Built with
`alexa+` `model-context-protocol` `mcp-apps` `amazon-bedrock` `amazon-nova` `amazon-bedrock-agentcore` `agentcore-gateway` `agentcore-policy` `cedar` `aws-lambda` `amazon-dynamodb` `amazon-cognito` `amazon-ses` `aws-cdk` `typescript` `python` `next.js`

---

## Form fields

| Field | Value |
|---|---|
| Primary track | Alexa+ |
| Mini challenges | AWS Builder; Open Source |
| Repository | `<https://github.com/OWNER/butler>` (public, MIT) |
| Demo video | `<YouTube URL>` (under 3:00) |
| Existing project? | No: built during the submission window |
| Open Source fields | see [`addon-sim/docs/devpost-open-source.md`](../addon-sim/docs/devpost-open-source.md) |
| Product feedback | paste from [`product-feedback.md`](product-feedback.md) |
| Friction log | paste the top entries from [`friction-log.md`](friction-log.md) and link the file |

**AWS services used (for AWS Builder), all running on the deployed stack:** Amazon Bedrock AgentCore Runtime (MCP server and agent), Gateway (five tool targets on one Lambda) and Policy (Cedar, ENFORCE); AWS Lambda (action tools, approval executor, debug API); Amazon DynamoDB (receipts, rules, plans); Amazon Cognito (machine identities for the agent, the approval executor and the simulator); AWS Secrets Manager and Systems Manager Parameter Store; AWS CDK; Amazon CloudWatch Logs; Amazon Polly (demo voices). Implemented but not live yet: Amazon Bedrock with Amazon Nova 2 Lite (zero quota on our new account) and Amazon SES email (the stack runs with test adapters).

## Feature requests (optional field)
- **Open the Alexa+ Web Simulator to hackathon participants** (Important): we couldn't verify tool routing or screen rendering against the real client.
- **Proactive notifications for MCP add-ons** (Important): agents that work in the background need a way to say "I need you" without waiting to be asked.
- **Faster policy activation, or a documented latency** (Critical for safety): new policies took 7–13 s to become ACTIVE in our tests; products must know when a rule is really in force.
- **Analyse only principals the gateway can produce** (Important): validation flagged our JWT-only rules as "overly restrictive" for IAM principals.
- **Non-zero default Bedrock quotas for new accounts** (Important): we couldn't call any Nova model on day one.
