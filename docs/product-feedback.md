# Product feedback (for the Devpost form)

One block per tool/API/SDK actually used. Fill the **(to complete after deploy)** parts once the AWS spikes are done.

### Alexa+ MCP add-on design guide and docs
- **Used for:** tool design, display modes (inline/fullscreen/hydrated/voice-only), the four layouts, spoken-response rules.
- **Worked well:** the design guide is concrete and opinionated ("one tool per intent", "never return empty", voice-only baseline, 500 ms first item). It shaped the tool set directly.
- **Needs work:** tooling gated for participants (FL-03); protocol-version mismatch (FL-02); no public way to see how Alexa picks between tools.
- **Onboarding:** reading to first tool: about 1 hour.
- **Build again?** Yes, if a public inspector exists.

### MCP TypeScript SDK 1.32 and MCP Apps (ext-apps 1.7)
- **Used for:** the Alexa-facing server (stateless Streamable HTTP), six `ui://` views.
- **Worked well:** negotiation of 2025-11-25 worked out of the box; `registerAppTool`/`registerAppResource` are clean.
- **Needs work:** stateless + elicitation (FL-04), output-schema validation on errors (FL-05), view bundle size (FL-06).
- **Build again?** Yes.

### Amazon Bedrock (Converse) and Amazon Nova 2 Lite
- **Used for:** fast needs pass, planner tool-use loop, rule drafting (forced tool choice for structured output), simulator brain. Every step also has an offline implementation.
- **Worked well:** one Converse API for every model, so switching from Claude to Nova was a config change; tool use and forced tool choice map cleanly onto our contracts.
- **Needs work:** a brand-new account had a 0 tokens/day quota for every Nova model and Service Quotas would not accept a request below the 8M default (FL-10); Anthropic models needed a separate use-case form (FL-01); Nova Premier is already end-of-life. **(to complete)** quality notes once Nova 2 Lite runs the planner evals.

### Amazon Bedrock AgentCore: Runtime, Gateway, Policy
- **Used for:** (to complete after deploy) hosting the MCP server and agent; routing every action through Gateway; enforcing user rules with Policy (Cedar) outside the model.
- **Notes so far (docs/samples only):** FL-07, FL-08, FL-09. CloudFormation coverage for Gateway, Policy engine and Runtime exists in `aws-cdk-lib`, which made the stack definable as code.

### Strands Agents / AWS services (DynamoDB, Lambda, SES, Cognito, CDK)
- **Used for:** (to complete after deploy). Local runs used moto (DynamoDB) so no AWS cost during development.
- AWS services used and how, for the AWS Builder challenge: see `infra/README.md` once finished.
