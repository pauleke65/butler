# Product feedback (for the Devpost form)

One block per tool, API or SDK we used. The friction-log entries (FL-xx) are in [`friction-log.md`](friction-log.md).

**AWS services used and how (AWS Builder).** Everything below ran on our deployed `dev` stack, which is also what the demo video shows:

- **Amazon Bedrock AgentCore:**
  - **Runtime** hosts the Alexa-facing MCP server and the planner agent.
  - **Gateway** fronts five Lambda tool targets; every action Butler takes goes through it.
  - **Policy** (Cedar, ENFORCE mode) turns a user's corrections into rules that block tool calls outside the model.
- **AWS Lambda:** the tools, the approval executor and the debug API.
- **Amazon DynamoDB:** receipts, rules and plans.
- **Amazon Cognito:** separate machine identities for the agent, the approval executor and the simulator.
- **AWS Secrets Manager** and **Systems Manager Parameter Store.**
- **Amazon CloudWatch Logs.**
- **AWS CDK:** one stack for all of it.
- **Amazon Polly:** the demo voices.
- **Not live yet:**
  - **Amazon Bedrock with Amazon Nova 2 Lite.** The code path is implemented and tested, but our new account has zero quota.
  - **Amazon SES.** The stack runs with test adapters.

### Alexa+ MCP design guide and docs
- **Used for:** tool design (one tool per intent, never empty, voice-only summaries); the inline, fullscreen and voice-only display modes; and the List, Carousel and Card layouts with the guide's type and spacing tokens.
- **Worked well:** the guide is concrete and opinionated, and it shaped our tool set and screens directly. The 500 ms first-item budget and the far-field type scale are especially useful.
- **Needs work:**
  - The Alexa+ simulator and toolkit are gated for participants (FL-03), so we built our own (addon-sim).
  - The client lifecycle docs show protocol 2025-03-26 while the hackathon requires 2025-11-25 (FL-02).
  - There's no public way to see how Alexa+ picks between tools.
- **Onboarding:** about an hour from reading to a first tool.
- **Build again?** Yes. An open simulator would make it much faster.

### MCP TypeScript SDK 1.32 and MCP Apps (ext-apps 1.7)
- **Used for:** the stateless Streamable HTTP server (negotiates 2025-11-25), nine tools, six `ui://` views, and the simulator's host side (AppBridge).
- **Worked well:**
  - Protocol negotiation worked out of the box.
  - `registerAppTool` and `registerAppResource` are clean.
  - AppBridge made a real sandboxed host possible in a day.
- **Needs work:**
  - Stateless servers can't elicit (FL-04).
  - The client validates `structuredContent` against `outputSchema` even for errors (FL-05).
  - The `App` class adds about 445 KB per view, so we wrote a small bridge (FL-06).
  - Hosts need the view's color-scheme to match, or the browser paints an opaque backdrop behind a transparent view; worth documenting.
- **Onboarding:** under an hour.
- **Build again?** Yes.

### Amazon Bedrock AgentCore Runtime
- **Used for:** hosting the MCP server (NODE_22, direct code deploy, no Docker) and the planner agent (PYTHON_3_12), with Cognito JWT inbound auth.
- **Worked well:**
  - Direct code deploy without containers.
  - JWT authorizers.
  - The `aws-cdk-lib` constructs let us define everything as code.
- **Needs work:**
  - NODE_22 requires a `.js` entrypoint, and the error doesn't say so (FL-13).
  - The runtime creates its own log group, so a CDK-managed one fails the deploy (FL-12).
  - Cold start is about 10 s (FL-18), so clients need long timeouts for the first call.
- **Onboarding:** about a day from first deploy to a working MCP endpoint, including two rollbacks.
- **Build again?** Yes.

### Amazon Bedrock AgentCore Gateway
- **Used for:** every action Butler takes. Five Lambda targets (Messages, Calendar, Supplies, Services, Context) sit behind one MCP endpoint, with tool names like `Supplies___checkout`, authorised per identity with Cognito client credentials.
- **Worked well:**
  - One endpoint for all tools.
  - Per-identity JWTs, so the agent and the approval executor are distinguishable to policies.
  - Request IDs on every call made our receipts auditable.
- **Needs work:** a denial comes back as JSON-RPC -32002, with the policy ID embedded in the message string. A structured field (decision, policy IDs) would save parsing.
- **Build again?** Yes.

### Amazon Bedrock AgentCore Policy (Cedar)
- **Used for:** user corrections ("don't buy drinks without asking me") become Cedar `forbid` rules in ENFORCE mode on the gateway. The engine is default-deny with a base permit, and "ask first" rules apply to the agent's identity only. The demo's denial is a real policy decision.
- **Worked well:**
  - Enforcement really is outside the model.
  - Validation catches malformed policies before they go live.
  - Denials arrive before the tool runs.
  - It's the strongest part of the stack for agent safety.
- **Needs work:**
  - Tool-specific policies must target the gateway ARN, not `resource is AgentCore::Gateway`, which isn't documented (FL-11).
  - Validation flags agent-only rules as "Overly Restrictive" for IAM principals the gateway can never produce (FL-14).
  - CreatePolicy needs `bedrock-agentcore:GetGateway`, and runtime-created policies also need `InvokeGateway` (FL-15, FL-17). Neither is in the docs.
  - New policies take 7–13 s to become ACTIVE, with no documented guarantee of when enforcement starts (FL-16), so products can't tell users exactly when a rule is live.
  - Cedar skips a rule that errors, so a missing or mistyped field fails open unless every rule is guarded (FL-07).
- **Onboarding:** about a day to the first enforced rule.
- **Build again?** Yes, definitely.

### Amazon Bedrock (Converse) and Amazon Nova 2 Lite
- **Used for:** the planner's tool-use loop, rule drafting (forced tool choice for structured output), the fast needs pass and the simulator's brain. Every step also has a deterministic offline implementation.
- **Worked well:** one Converse API for every model, so switching models is a config change. Tool use and forced tool choice map cleanly onto our contracts.
- **Needs work:**
  - A brand-new account gets a 0 tokens/day quota for every Nova model, and Service Quotas won't accept a request below the 8M default (FL-10).
  - Anthropic models need a separate use-case form, and the error doesn't link to it (FL-01).
  - Because of the quota, the deployed stack ran the offline implementations.
- **Build again?** Yes, once the quota is in place.

### Amazon Cognito, AWS Lambda, Amazon DynamoDB, AWS CDK
- **Used for:**
  - **Cognito:** machine identities via client credentials (agent, approval executor, simulator).
  - **Lambda:** tools, executor and debug API.
  - **DynamoDB:** receipts, rules and plans.
  - **CDK:** one stack.
- **Worked well:** all four were predictable. Local runs used moto, so development cost nothing.
- **Needs work:** nothing blocking.
- **Build again?** Yes.

### Amazon Polly
- **Used for:** the demo video's voices (generative Ruth, Matthew and Stephen), and the simulator's spoken replies.
- **Worked well:** the generative voices sound natural, and a whole take cost a few cents.
- **Needs work:** nothing blocking.
- **Build again?** Yes.
