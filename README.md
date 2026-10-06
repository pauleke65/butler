# Butler

**An Alexa+ add-on that acts on your behalf, keeps a receipt for every action, and turns your corrections into rules it cannot break.**

Built for the [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) (Alexa+ track, with the AWS Builder and Open Source mini challenges).

> You describe a situation: *"six friends are coming over Friday at 7"*. Butler works out what that needs and handles it: invites, calendar, groceries, a cleaner. Every action leaves a **receipt** (what, why, what it rejected, which rule allowed it). When you object (*"don't buy drinks without asking me"*), Butler turns it into a **rule enforced outside the AI model**, so the next attempt is blocked and Butler asks instead.

## How it fits together

```
 addon-sim (Alexa+ style simulator)          Butler
 ┌─────────────────────────┐   MCP over    ┌───────────────────┐  start/resume   ┌─────────────────────────┐
 │ voice, "Alexa brain",   │ ─ Streamable ▶│ MCP server (TS)   │ ──────────────▶ │ Planner agent (Python)  │
 │ MCP Apps host (screens) │ ◀─── HTTP ─── │ 9 tools + 6 views │                 │ Strands / Bedrock       │
 └─────────────────────────┘               └─────────┬─────────┘                 └───────────┬─────────────┘
                                                     │ approvals                             │ every action
                                                     ▼                                       ▼
                                           ┌───────────────────┐               ┌──────────────────────────┐
                                           │ Approval executor │──────────────▶│ AgentCore Gateway        │
                                           │ (deterministic)   │               │  + Policy (Cedar rules)  │──▶ ALLOW / DENY
                                           └───────────────────┘               └────────────┬─────────────┘
                                                                                            ▼ (if allowed)
                                                                      email · calendar · checkout · bookings
```

- **Why the AI can't approve itself:** the agent and the approval executor hold different identities. "Ask first" rules block only the agent. When you say yes, plain code, not the model, runs the action.
- **Corrections become rules:** the model drafts a rule from a small set of templates; deterministic code compiles it to [Cedar](https://www.cedarpolicy.com/) and activates it. The model never writes policy code.

## Repo map

| Path | What |
|---|---|
| `server/` | Alexa-facing MCP server (TypeScript) and `server/ui/` MCP Apps screens |
| `agent/` | Planner agent: scripted (offline) and Bedrock-backed |
| `actions/` | Action tools behind the gateway: email, calendar, shopping, services, weather |
| `libs/butler_rules/` | Rule templates, Cedar compiler, matcher, policy service |
| `libs/butler_actions/` | Store, action-call wrapper, receipts, scoring, spoken summaries |
| `executor/` | Approval executor |
| `local/` | Local stack: DynamoDB (moto), gateway emulator evaluating real Cedar, seed loader, supervisor |
| `debug-api/` | Read-only API feeding the live "Black Box" panel |
| `sim-panel/` | Black Box panel plugin for the simulator |
| `addon-sim/` | The simulator (open source, separate from Butler, MIT) |
| `packages/contracts/` | Shared schemas (zod → JSON Schema → Pydantic) |
| `handoff/`, `SPEC.md` | Product spec and the full build handoff pack |

## Run it locally (no AWS needed)

```bash
make install        # pnpm install + uv sync (Python 3.12)
make test           # all Python + TypeScript tests
make dev            # local stack: DB, gateway emulator, executor, agent
pnpm --filter ./server dev          # MCP server on :8000/mcp
pnpm --dir addon-sim dev            # simulator on :3000
```

Modes (`LLM_MODE`): `offline` (default, deterministic) or `bedrock` (real models via Amazon Bedrock). See `handoff/05-local-build.md`.

## Where MCP and Cedar are actually used
- MCP server entry point: `server/src/index.ts` (tools in `server/src/tools/`, screens in `server/ui/`)
- Policy enforcement: `libs/butler_rules/` (compile + real-Cedar evaluation) and `local/butler_local/gateway.py`; in AWS the same policies attach to AgentCore Gateway
- Receipts: `libs/butler_actions/butler_actions/wrapper.py`

## Licence
MIT. The simulator is a generic tool and is not affiliated with Amazon.
