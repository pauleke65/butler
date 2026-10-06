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

### Amazon Bedrock (Converse)
- **Used for:** (to complete after deploy) fast needs pass, planner, rule drafting, simulator brain; all behind an offline implementation.
- **Needs work:** access gating and error message (FL-01).

### Amazon Bedrock AgentCore: Runtime, Gateway, Policy
- **Used for:** (to complete after deploy) hosting the MCP server and agent; routing every action through Gateway; enforcing user rules with Policy (Cedar) outside the model.
- **Notes so far (docs/samples only):** FL-07, FL-08, FL-09. CloudFormation coverage for Gateway, Policy engine and Runtime exists in `aws-cdk-lib`, which made the stack definable as code.

### Strands Agents / AWS services (DynamoDB, Lambda, SES, Cognito, CDK)
- **Used for:** (to complete after deploy). Local runs used moto (DynamoDB) so no AWS cost during development.
- AWS services used and how, for the AWS Builder challenge: see `infra/README.md` once finished.
