# 06 — As built (2026-10-06)

Status of the handoff pack against the code. **Where this file and `01-contracts.md` differ, this file wins**; the full per-workstream detail is in `CONTRACT-REQUESTS.md`.

## What exists and is verified locally
| Area | Status | Verified by |
|---|---|---|
| Contracts (zod → JSON Schema → Pydantic), fixtures | done | contract tests in both languages, drift check |
| Rules: 7 templates, Cedar compiler, Python matcher, real-Cedar evaluator | done | 12 rule sets × 2 principals × ~45 calls parity matrix (matcher == Cedar); fail-open tests |
| Action wrapper, receipts, might_disagree, spoken summaries + lint | done | unit + local e2e tests |
| Approval executor | done | atomic approval (6-way concurrent test), never-rule block, undo |
| Action handlers (12 tools), fake + real adapters | done (fake verified; real adapters stub-tested only) | `actions/tests` |
| Agent (scripted planner, rule drafter, ops router, HTTP server) | done offline; Bedrock paths written, not verified on the real models | `agent/tests`, evals 15/15 situations, 18/18 supported rule utterances |
| MCP server (9 tools + 2 app-only), 6 MCP Apps views | done | 197 server tests, MCP-level test over HTTP, protocol 2025-11-25 negotiated |
| Simulator `addon-sim` + Black Box panel | done | 59 tests; **golden demo 13/13 against the real local stack, repeatable**; browser run through the real MCP Apps host |
| Local stack (moto DynamoDB, gateway emulator running real Cedar, executor, debug API, agent) | done | `scripts/stack.sh start` |

## Contract deviations that matter (folded from CONTRACT-REQUESTS)
- **Server language** is TypeScript, agent/Lambdas Python (D1/D2 held).
- **`spend_cap`** compiles to one policy with `action in [...]`; every forbid uses `resource is AgentCore::Gateway`; types are checked in the wrapper because Cedar type errors fail open.
- **ALLOW receipts** now name the allowing spend-cap rule (`authority.rule_ids`), only for the agent principal and only when the amount is within the cap.
- **Rule changes settle** for `POLICY_SETTLE_MS` (default 1500) before reporting success (found by the first full-stack run).
- **Elicitation is not used.** A stateless MCP server cannot elicit with SDK 1.32; the two-step `confirm` flow is the only path (D10 resolved).
- **Services needs** are created as `doing`; the agent turns them into `needs_you` decisions.
- **Receipts for read-only tools** are written but excluded from `list_actions`, the ledger and reference resolution.
- **`might_disagree` "first of its kind"** applies to checkout and book_service only.
- **Error envelope** carries `spoken_summary`; `outputSchema` is `oneOf [success, error]`; `POLICY_PROPAGATING` returns `ok: true`.
- **Views** use an in-repo bridge instead of the ext-apps `App` class (445 KB vs 27-34 KB per view).
- **Weather** is deterministic offline unless `WEATHER_MODE=live` or `ADAPTERS=real`.
- **CloudFormation covers AgentCore** Gateway, GatewayTarget, PolicyEngine, Policy and Runtime in `aws-cdk-lib`, so D18 resolved to CDK for everything.

## Not done / needs AWS or the user
1. **Bedrock access:** the account must submit Anthropic's use-case form and enable the models; until then only `LLM_MODE=offline` runs.
2. **Spikes S-1/S-2/S-3** (real Policy denial shape and propagation, Runtime hosting, AgentCore async agent) need a real deployment.
3. **Real integrations** (SES, Google Calendar, Stripe/Paystack test mode) are coded and stub-tested; none has sent a real request.
4. **Dockerfiles** are written but unbuilt (no Docker on this machine).
5. **Latency pass (M-24)** and **Nova/Polly voice** not measured live; push-to-talk needs a real mic in Chrome.
6. **Demo video, Devpost text, submission** (D-4 to D-9) are Paul's.

## Day-to-day commands
```bash
make install                      # pnpm + uv
make test                         # Python + TS suites
scripts/stack.sh start|stop|status   # local backend + MCP server
pnpm --dir addon-sim dev          # simulator on :3000
pnpm --dir addon-sim play scripts/butler-golden.yaml --url http://localhost:8000/mcp --token local-sim-token
uv run python -m butler_local.seed --reset   # reset the demo between runs
uv run python evals/run.py        # planner + rule-drafter evals (offline)
```
