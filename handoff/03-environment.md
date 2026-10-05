# 03 — Environment, tooling and workflow

## 1. Repo layouts

### `butler` (public, MIT)
```
butler/
  packages/
    contracts/
      ts/            zod schemas + types (source)
      schemas/       generated JSON Schemas
      py/            generated Pydantic models
      fixtures/      shared JSON fixtures (SET-7)
  server/            Alexa-facing MCP server (TypeScript)          CODEOWNER: Head C
    src/tools/       one file per tool (§3 of contracts)
    src/lib/         envelope, errors, resolver, lintSpoken, repo
    ui/              MCP Apps views (Vite → single-file HTML)
    Dockerfile       linux/arm64
  agent/             Strands planner on AgentCore Runtime (Python)  CODEOWNER: Head B
  actions/           Gateway Lambda targets (Python)               CODEOWNER: Head B
    messages/ calendar/ supplies/ services/ context/
  executor/          approval-executor Lambda (Python)             CODEOWNER: Head B
  libs/
    butler_actions/  call_action wrapper, receipts (Python)        CODEOWNER: Head B
    butler_rules/    templates, compiler, matcher, policy service  CODEOWNER: Head A
  infra/             CDK app (TypeScript) + agentcore scripts      CODEOWNER: Head A
  debug-api/         Black Box debug API Lambda                    CODEOWNER: Head A
  sim-panel/         Butler panel plugin for addon-sim            CODEOWNER: Head D
  policies/          golden Cedar outputs per template             CODEOWNER: Head A
  prompts/           versioned prompt files                        CODEOWNER: Heads B, C
  evals/             situation + rule evals                        CODEOWNER: Head B
  seed/              household, contacts, catalogue, providers, history, load.py
  scripts/           golden demo YAML, reset helpers
  docs/              friction-log.md, product-feedback.md, security.md, architecture.png
  handoff/           this pack + spikes/
  SPEC.md  README.md  LICENSE  Makefile
```

### `addon-sim` (public, MIT)
```
addon-sim/
  app/               Next.js App Router (stage, inspector, transcript, settings)
  sandbox/           sandbox proxy served on a second origin (port 3001)
  lib/mcp/           MCP client manager, auth providers
  lib/brain/         Bedrock tool-use loop, prompts
  lib/voice/         speech-to-text, Polly
  lib/apps-host/     AppBridge wiring, resource cache, display modes
  panels/            plugin interface + built-in Inspector
  scripts/           runner CLI + example scripts
  README.md LICENSE
```

## 2. Prerequisites (every developer)

| Tool | Version | Why |
|---|---|---|
| Node.js | 20 LTS or newer | server, views, simulator, CDK, AgentCore CLI |
| pnpm | 9+ | TS workspace |
| Python | 3.12 | agent, Lambdas, libs |
| uv | latest | Python workspace + lockfile |
| Docker + buildx | latest, with `linux/arm64` emulation | AgentCore Runtime containers are arm64 |
| AWS CLI v2 | latest | auth, ad-hoc checks |
| AWS CDK v2 | latest | `infra/` |
| AgentCore CLI / starter toolkit | per S-1 (`npm i -g @aws/agentcore` or `pip install bedrock-agentcore-starter-toolkit`) | Runtime, Gateway, Policy |
| Chrome | latest | Web Speech API in the simulator |

Auth: AWS IAM Identity Center profile `butler-dev` (`aws sso login --profile butler-dev`). Never use root keys.

## 3. Stages

| Stage | Purpose | Who deploys | Data |
|---|---|---|---|
| `local` | each dev's laptop; points at `dev` AWS resources except the process they're working on | anyone | `dev` table with per-developer `HH#hh_<name>` household |
| `dev` | shared integration | merges to `main` (manual `make deploy STAGE=dev` until CI deploy exists) | test data, resettable |
| `demo` | frozen for rehearsal and recording | Paul / Head A after G4 | seed data only, reset before each run |

All resource names are `butler-{stage}-*`. Outputs (ARNs, URLs, client ids) live in SSM `/butler/{stage}/*`; code reads them at startup (no hard-coded ARNs).

## 4. Environment variables

### Server (`server/`)
| Var | Example | Notes |
|---|---|---|
| `STAGE` | `dev` | |
| `AWS_REGION` | `us-east-1` | |
| `TABLE_NAME` | `butler-dev` | |
| `AGENT_RUNTIME_ARN` | from SSM | `InvokeAgentRuntime` target |
| `EXECUTOR_FUNCTION_NAME` | `butler-dev-approval-executor` | |
| `BEDROCK_MODEL_FAST` | Haiku 4.5 model id / inference profile | needs pass |
| `HOUSEHOLD_BY_SUB` | `{"*":"hh_demo"}` | JSON map token `sub` → household |
| `DEFAULT_TIMEZONE` | `America/New_York` | fallback |
| `LOG_LEVEL` | `info` | |
| `PORT` | `8000` | Runtime contract |

### Agent (`agent/`)
| Var | Notes |
|---|---|
| `STAGE`, `AWS_REGION`, `TABLE_NAME` | |
| `GATEWAY_URL` | MCP endpoint of the Gateway |
| `AGENT_CLIENT_SECRET_ARN` | Secrets Manager; Cognito `butler-agent` client credentials |
| `COGNITO_TOKEN_URL`, `AGENT_CLIENT_ID` | client-credentials flow |
| `BEDROCK_MODEL_PLANNER` | Sonnet id / inference profile |
| `POLICY_ENGINE_ID`, `GATEWAY_ARN` | for rule ops |
| `AGENT_SUB`, `EXECUTOR_SUB` | Cedar identities (client ids) |
| `MAX_STEPS=25`, `MAX_SECONDS=120` | loop caps |

### Executor (`executor/`)
`STAGE`, `AWS_REGION`, `TABLE_NAME`, `GATEWAY_URL`, `EXECUTOR_CLIENT_SECRET_ARN`, `COGNITO_TOKEN_URL`, `EXECUTOR_CLIENT_ID`

### Action Lambdas (`actions/*`)
`STAGE`, `TABLE_NAME`, `SES_FROM_ADDRESS`, `GOOGLE_REFRESH_TOKEN_SECRET_ARN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CALENDAR_ID`, `PAYMENT_PROVIDER` (`stripe`|`paystack`), `PAYMENT_SECRET_ARN`, `CATALOG_PATH`, `PROVIDERS_PATH`

### Simulator (`addon-sim`)
`AWS_REGION`, `BEDROCK_MODEL_BRAIN`, `POLLY_VOICE_ID` (a neural voice), `SANDBOX_ORIGIN=http://localhost:3001`, `DEFAULT_SERVERS` (JSON list), `PANEL_URLS` (dev only)

### Butler panel
`DEBUG_API_URL`, `DEBUG_API_TOKEN`

Secrets are **only** in Secrets Manager. `.env.example` files list every var with fake values; `.env` is git-ignored.

## 5. Local development

```bash
# once
pnpm install
uv sync
aws sso login --profile butler-dev
pnpm contracts:gen

# Terminal 1: MCP server (hot reload) on :8000/mcp, using dev AWS resources
pnpm --filter server dev

# Terminal 2: agent locally on :8080 (POST /invocations); set AGENT_LOCAL_URL in server .env to bypass InvokeAgentRuntime
uv run --package agent python -m agent.main

# Terminal 3: simulator on :3000 (+ sandbox on :3001)
cd ../addon-sim && pnpm dev
```

- The server supports `AGENT_LOCAL_URL` and `EXECUTOR_LOCAL=1` (runs the executor handler in-process via a Python subprocess or HTTP shim) for fast local loops.
- Action Lambdas are always the `dev` deployments (they hold the real integrations); test individual handlers with `uv run pytest actions/<name>`.
- Use your own household id (`HOUSEHOLD_BY_SUB={"*":"hh_<yourname>"}`) so you don't clobber teammates' data; seed it with `uv run seed/load.py --stage dev --household hh_<yourname>`.

## 6. Deploy

```bash
make deploy STAGE=dev      # CDK → Lambdas → Gateway/targets → Policy engine + defaults → runtimes → seed
make policy-test STAGE=dev # P-6 parity matrix
make evals STAGE=dev       # A-13
make reset-demo            # demo stage only
make destroy STAGE=dev     # tears down everything for the stage
```

Container images: `docker buildx build --platform linux/arm64`. Push to ECR repos created by CDK.

Manual one-time steps (documented in `infra/README.md`): Google OAuth refresh token (S-6 script), payment test key, SES identity verification clicks.

## 7. Testing strategy

| Layer | What | Where | When |
|---|---|---|---|
| Unit | handlers, resolver, compiler, matcher, lint, scoring | each package | every PR |
| Contract | outputs validate against schemas; generated code in sync | `packages/contracts`, `server` | every PR |
| Policy parity | matcher vs live Gateway (P-6) | `dev` | on rule/template changes + nightly |
| Integration | server → agent → Gateway → Lambdas → DynamoDB | `dev` | nightly + before gates |
| Evals | planner and rule-drafting quality (A-13) | `dev` | nightly + before G4 (≥ 90%) |
| E2E golden script | full demo via X-10 runner | `dev` nightly, `demo` before recording | nightly + rehearsals |
| Visual | view screenshots at 2 sizes from fixtures | `server/ui` | PRs touching views |

## 8. Cost control

- Bedrock: cap planner runs (25 steps / 120 s); evals nightly only.
- AgentCore Runtime: scales per invocation; nothing to stop.
- DynamoDB on-demand; Lambdas; negligible at demo scale.
- Budget alarms at $50/$100 (SET-1). Hackathon credit: $150 per person; each head can request their own (form closes 21 Oct 12pm PT).
- After judging (20 Nov): `make destroy STAGE=dev`; keep `demo` only if needed.

## 9. Conventions

- Commits: Conventional Commits (`feat(server): handle_situation`), ticket id in PR title.
- Python: Ruff, mypy strict on `libs/`, Pydantic models from contracts only.
- TypeScript: strict mode, Biome, zod at boundaries.
- Logging: JSON, always `correlation_id`, `household_id`, `plan_id` when known. No PII beyond first names in logs; never log tokens or full emails.
- Feature flags via env: `FEATURE_ELICITATION`, `FEATURE_UNDO`, `FEATURE_PREFERENCES`.
