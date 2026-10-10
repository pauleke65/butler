# Friction log

Real problems hit while building Butler (Alexa+ add-on on MCP, Amazon Bedrock AgentCore, AWS). Newest last.
Format per entry: task, steps, expected vs actual, severity, workaround, suggestion. Anything marked
**(unverified on the real service)** was observed with a local stand-in, not on AWS.

### FL-01 · First Bedrock call fails with "use case details not submitted" · 2026-10-06
- **Tool:** Amazon Bedrock (Converse), Anthropic models
- **Task:** call `us.anthropic.claude-haiku-4-5-20251001-v1:0` from a fresh account, as listed by `aws bedrock list-inference-profiles`.
- **Steps:** `aws bedrock list-foundation-models --by-provider anthropic` and `list-inference-profiles` show the models; then `aws bedrock-runtime converse ...`.
- **Expected:** a listed model is callable, or the listing says it needs an extra step.
- **Actual:** `ResourceNotFoundException: Model use case details have not been submitted for this account. Fill out the Anthropic use case details form...`. Strangely, one call succeeded earlier the same day and the same call failed minutes later. Sonnet 5.5 returned `AccessDeniedException` "not available for this account".
- **Severity:** major (blocks every LLM feature until the form is filled; message gives no link)
- **Workaround:** built every LLM feature behind an `offline` implementation (keyword needs pass, scripted planner, pattern-based rule drafter) so development and tests never depend on model access.
- **Suggestion:** have `list-inference-profiles` indicate access status per model, put the form URL in the error message, and make access state consistent (no succeed-then-fail).

### FL-02 · Alexa+ client lifecycle docs show protocol 2025-03-26, hackathon requires 2025-11-25 · 2026-10-06
- **Tool:** Alexa+ MCP add-on docs ("Alexa+ MCP Client and App Lifecycle")
- **Task:** decide which MCP protocol version the server must negotiate.
- **Expected:** the docs and the hackathon rules agree.
- **Actual:** the docs' `initialize` example sends `protocolVersion: "2025-03-26"`; the hackathon rules require the 2025-11-25 spec or later.
- **Severity:** minor
- **Workaround:** server negotiates 2025-11-25 and also accepts 2025-06-18 / 2025-03-26.
- **Suggestion:** state which versions Alexa+'s client actually sends and which spec features (elicitation, tasks, tool icons) it honours.

### FL-03 · Official Alexa+ simulator and toolkit are gated for hackathon participants · 2026-10-06
- **Tool:** Alexa+ MCP toolkit / Web Simulator
- **Task:** test an MCP add-on the way Alexa+ will call it.
- **Actual:** the FAQ confirms participants have no access; the public docs describe the design guide only.
- **Severity:** major for fidelity (cannot check rendering or tool routing against the real client)
- **Workaround:** built and open-sourced a generic MCP Apps simulator (`addon-sim`) following the public design guide's layouts and display modes.
- **Suggestion:** publish a minimal public local inspector for the MCP Apps display modes and the Alexa+ tool-selection prompt.

### FL-04 · Stateless MCP server cannot ask the user questions (elicitation) · 2026-10-06
- **Tool:** `@modelcontextprotocol/sdk` 1.32 (TypeScript), Streamable HTTP
- **Task:** use form elicitation to confirm a new rule in one turn.
- **Steps:** per-request server instance (as AgentCore Runtime's stateless mode requires), call `server.elicitInput(...)` inside a tool.
- **Expected:** works when the client declared `elicitation`.
- **Actual:** `Client does not support form elicitation`: a server created per request never sees `initialize`. It also needs `{ relatedRequestId }` so the request rides the tool call's own stream.
- **Severity:** major (design-affecting)
- **Workaround:** two-step confirmation (`needs_confirmation: true`, then `confirm: true`) as the main path; elicitation is optional.
- **Suggestion:** document the stateless + elicitation limitation, or let a stateless transport carry the client capabilities per request.

### FL-05 · MCP SDK client validates `structuredContent` against `outputSchema` even for errors · 2026-10-06
- **Tool:** `@modelcontextprotocol/sdk` client
- **Actual:** an `isError: true` result whose `structuredContent` is an error envelope fails client-side validation against the tool's success `outputSchema`.
- **Severity:** minor
- **Workaround:** advertise `outputSchema` as `oneOf [success, error envelope]`.
- **Suggestion:** skip output validation when `isError` is true, or document the expectation.

### FL-06 · MCP Apps `App` class is 445 KB per view · 2026-10-06
- **Tool:** `@modelcontextprotocol/ext-apps` 1.7
- **Task:** ship six small self-contained views (limit 200 KB each) for inline Alexa+ rendering.
- **Actual:** importing `App` pulls the MCP SDK's schemas and zod into every bundle: 445 KB.
- **Severity:** minor
- **Workaround:** wrote a ~100-line bridge speaking the same `ui/initialize`, tool-result and `tools/call` messages; checked it against the real host-side `AppBridge`. Views are 27-34 KB.
- **Suggestion:** ship a slim, tree-shakeable view client without the full protocol schemas.

### FL-07 · Cedar `forbid` rules fail open on missing or wrongly-typed input **(found locally with cedarpy; unverified on AgentCore Policy)** · 2026-10-06
- **Tool:** Cedar / AgentCore Policy examples
- **Task:** write a rule that blocks `checkout` above a spend cap.
- **Actual:** an unguarded `forbid ... when { context.input.amount_minor > 5000 }` evaluates to an error when the field is missing, the policy is skipped, and the base `permit` allows the call. A guard (`context has input && context.input has amount_minor`) handles missing fields but not a wrong type (`"9000" > 5000` still errors).
- **Severity:** major (a safety rule silently not applying)
- **Workaround:** guard every access; validate types in the wrapper before the call and fail closed (`INVALID_INPUT`); register strict, typed, `required` gateway input schemas.
- **Suggestion:** show guarded patterns in the AgentCore Policy samples, and surface "policy evaluation errored" in the decision response so it can't be mistaken for an allow.

### FL-08 · AgentCore Policy engine is default-deny, so a base permit is needed first · 2026-10-06
- **Tool:** AgentCore Policy (from the AWS samples)
- **Actual:** with no `permit`, every call is denied; the first sample forbids only work once an `AllowAll` permit exists. Easy to miss when starting from forbid-only examples.
- **Severity:** minor
- **Workaround:** a base `permit` limited to the two known principals, plus `forbid` rules on top.
- **Suggestion:** call this out at the top of the policy quickstart.

### FL-09 · No stated guarantee for when an ACTIVE policy is enforced **(unverified on the real service)** · 2026-10-06
- **Tool:** AgentCore Policy
- **Task:** tell the customer "that rule is now in force" truthfully.
- **Actual:** the control-plane status becoming `ACTIVE` is the only signal; docs don't say whether the Gateway enforces it at that moment. We assumed some lag could exist and, after seeing the effect in a local emulator, made rule changes wait for a configurable settle window (`POLICY_SETTLE_MS`) before reporting success.
- **Severity:** unknown until measured (spike S-1 on a real account)
- **Suggestion:** document enforcement latency after `ACTIVE`, or add a "policy version in effect" field to gateway responses.

### FL-10 · New account has a 0 tokens/day quota for every Amazon Nova model · 2026-10-07
- **Tool:** Amazon Bedrock quotas (Nova 2 Lite, Nova Pro, Nova Lite, Nova Micro)
- **Task:** first Converse call to `us.amazon.nova-2-lite-v1:0` from a newly verified account.
- **Expected:** a small default quota so a developer can try the model.
- **Actual:** `ThrottlingException: Too many tokens per day` on the very first call. Service Quotas shows 0 for "Model invocation max tokens per day" (not adjustable) and 0 for the tokens-per-minute quotas; only the cross-region tokens-per-minute quotas are adjustable. Nova Premier, the strongest Nova, is already end-of-life.
- **Severity:** major (no model usable at all on day 1)
- **Workaround:** offline implementations for every model-backed step; requested a cross-region TPM increase.
- **Suggestion:** give new accounts a small non-zero default, and name the adjustable quota to raise in the throttling message.

## Findings from the first real AWS deploy (2026-10-10)

### FL-11 · AgentCore Policy rejects tool-specific policies on `resource is AgentCore::Gateway` · 2026-10-10
- **Tool:** AgentCore Policy (CloudFormation `AWS::BedrockAgentCore::Policy`)
- **Task:** create `forbid (principal, action == AgentCore::Action::"Supplies___checkout", resource is AgentCore::Gateway) when {…}`.
- **Actual:** `ValidationException: … a constrained action scope was encountered, please constrain the resource to a specific AgentCore::Gateway resource when creating tool-specific policies.`
- **Severity:** blocker (first deploy rolled back)
- **Workaround:** compile `resource == AgentCore::Gateway::"<gateway arn>"`; CDK injects the real ARN. Because a wrong ARN would make a forbid silently never match, the live check calls the gateway with both identities after every deploy.
- **Suggestion:** document the rule next to the Cedar examples, and warn (or fail) when a forbid's resource ARN matches no gateway attached to the engine.

### FL-12 · AgentCore Runtime creates its own log group, so pre-creating it fails · 2026-10-10
- **Tool:** AgentCore Runtime + CloudFormation
- **Actual:** `AWS::Logs::LogGroup … /aws/bedrock-agentcore/runtimes/<id>-DEFAULT already exists`; the stack rolled back and left the group behind.
- **Severity:** major
- **Workaround:** set retention with `LogRetention` instead of creating the group; cleanup script deletes orphaned groups after a failed deploy.
- **Suggestion:** a `logRetention` property on the Runtime construct.

### FL-13 · NODE_22 runtime requires a `.js` entrypoint · 2026-10-10
- **Tool:** AgentCore Runtime direct code deployment (Node 22)
- **Actual:** `Entrypoint file type does not match your selected runtime. For NODE_22 runtime, your file should end with .js` (our ESM entry was `entry.mjs`).
- **Severity:** minor
- **Workaround:** `entry.js` + `package.json` with `"type": "module"`.
- **Suggestion:** accept `.mjs`/`.cjs`, or say so in the code-deployment docs.

### FL-14 · Policy validator flags agent-only forbids as "Overly Restrictive" for IAM principals · 2026-10-10
- **Tool:** AgentCore Policy validation (`FAIL_ON_ANY_FINDINGS`)
- **Actual:** `Overly Restrictive: Policy Engine will deny every request for the specified principal (AgentCore::IamEntity), action (Messages___send_email)…` for a forbid that only applies to one JWT client. Our gateway accepts only JWT callers, so IAM principals never reach it.
- **Severity:** major (blocked deploy)
- **Workaround:** `IGNORE_ALL_FINDINGS` for policy creation, plus our own parity tests and a live allow/deny check after every deploy.
- **Suggestion:** analyse only the principal types the gateway's authorizer can produce.

### FL-15 · CreatePolicy needs `bedrock-agentcore:GetGateway` · 2026-10-10
- **Tool:** AgentCore Policy + IAM
- **Actual:** the agent creating a rule at runtime got `AccessDeniedException … Failed to confirm existence on AgentCore Gateway … please make sure you have "bedrock-agentcore:GetGateway" permissions`.
- **Severity:** major (corrections could not become rules)
- **Workaround:** grant `GetGateway`, `ListGatewayTargets`, `GetGatewayTarget` on our gateway.
- **Suggestion:** list the gateway permissions on the CreatePolicy IAM page.

### FL-16 · New policies take 7–13 s to become ACTIVE (measured) · 2026-10-10
- **Tool:** AgentCore Policy
- **Measured:** create → ACTIVE in 12.5 s and 7.5 s; the gateway denied on the first check after ACTIVE (≤ 1.4 s later).
- **Impact:** too slow to wait for inside a voice turn, and an action taken in that window would slip through.
- **Workaround:** Butler confirms the rule at once and holds matching actions itself while the rule is `creating`; activation finishes in the background, then the gateway enforces it.
- **Note (positive):** the real denial is a clear JSON-RPC error, `-32002 "Tool Execution Denied: … [Policy evaluation denied due to <policy id>]"`, so receipts can cite the exact policy.
