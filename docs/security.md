# Security notes

Checked 2026-10-06 (code review + tests; nothing deployed yet).

## What protects the user
- **Rules are enforced outside the model.** The agent's tool calls go through the gateway, which evaluates Cedar policies. The model never writes policy code: it drafts a template + params that deterministic code validates and compiles (`libs/butler_rules`).
- **The AI cannot approve itself.** Two identities: `butler-agent` (blocked by "ask first" rules) and `approval-executor` (a separate, deterministic component that holds its own credential and only runs after a customer's `answer_decision`). `never` rules block both.
- **Fail closed on bad input.** Cedar skips a policy that errors, so a rule can fail open on a missing or wrongly-typed field (see friction log FL-07, reproduced with real Cedar). Every policy-relevant field is guarded in the Cedar, type-checked in the wrapper before any gateway call (`INVALID_INPUT`), and re-validated in each action handler (e.g. checkout recomputes the total from the catalogue).
- **Idempotency and double-approval safety.** Side effects carry idempotency keys; a decision can be approved once (conditional write); 6-way concurrent approvals execute once (tested).
- **Receipts for everything**, including denied calls, so there is always an audit trail.
- **Household comes from the token, never from tool input.**

## Hardening done in this pass
| Finding | Fix |
|---|---|
| Static dev token `local-sim-token` would have been accepted on a deployed stage | accepted only when `STAGE=local` (test added) |
| Debug API defaulted to a well-known token on any stage | on non-local stages it stays closed unless `DEBUG_API_TOKEN` is set to a non-default value (test added) |
| Unauthenticated local services listened on all interfaces | gateway emulator, executor, debug API, agent (via the supervisor) and the MCP server (local stage) bind to loopback by default |
| A rule that is `ACTIVE` may not yet be enforced, so the next action could slip through | rule changes wait for a settle window (`POLICY_SETTLE_MS`) before being reported as in force; tune it from measurements on the real gateway |

## Known gaps (to close before a real deployment)
- **Not verified on AWS:** AgentCore Policy validation of our Cedar, the real denial response shape, enforcement latency, Cognito token flows. First deploy must run the parity matrix (`make policy-test`) against the live gateway.
- **JWT verification:** on a deployed stage the server trusts the AgentCore Runtime authorizer to have verified the token and only reads `sub`; add JWKS verification if the server is ever exposed another way.
- **Prompt injection:** model-visible text from tools (product names, contact names, provider names) is untrusted. The mitigation is structural: the agent can only call the 12 gateway tools, every call is policy-checked, emails go only to saved contacts (or are held), and rule drafts are template-validated. Keep catalogue/provider data from untrusted sources out of the prompt.
- **Real money:** payments run in test mode only; no live keys exist in the repo (secret scan clean). Keep it that way for the demo.
- **SES sandbox** limits recipients to verified addresses; do not request production access for the hackathon.
- **PII:** contacts are demo addresses; logs carry first names only and no tokens.
