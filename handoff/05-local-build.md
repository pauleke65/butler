# 05 — Local build: module APIs, ports, modes

How the pieces run on one laptop with **no AWS deploys**, and the exact Python/TS module boundaries the parallel workstreams code against. `01-contracts.md` stays the source of truth for wire shapes; this file adds what the contracts leave open.

## 1. Local topology

| Service | Port | Provided by | Replaces (in AWS) |
|---|---|---|---|
| Local DynamoDB (moto server) | 5555 | `uv run python -m butler_local.devdb` | DynamoDB |
| Local Gateway emulator | 8090 | `butler_local.gateway` | AgentCore Gateway + Policy (evaluates the **real compiled Cedar** with `cedarpy`) |
| Agent (Python) | 8080 | `butler_agent.server` (`POST /invocations`, `GET /ping`) | AgentCore Runtime (agent) |
| Approval executor | 8081 | `butler_executor.server` (`POST /invoke`) | Lambda `butler-approval-executor` |
| Debug API | 8085 | `debug-api` | Function URL Lambda |
| Butler MCP server (TypeScript) | 8000 (`/mcp`) | `server/` | AgentCore Runtime (server) |
| Simulator | 3000 (+ sandbox 3001) | `addon-sim/` | the (gated) Alexa+ Web Simulator |

`make dev` (owned by `local/`) starts everything except the simulator and server, which have their own `pnpm dev`. `make seed` loads seed data. `make test` runs all tests.

Local tokens (static strings, not secrets): `local-agent-token` → principal `butler-agent`; `local-executor-token` → `approval-executor`; `local-sim-token` → simulator/server caller.

### Environment (local defaults)
```
STAGE=local  AWS_REGION=us-east-1  TABLE_NAME=butler-local
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test        # only for moto; Bedrock mode uses real creds, see LLM_MODE
DYNAMODB_ENDPOINT=http://localhost:5555
GATEWAY_URL=http://localhost:8090/mcp
AGENT_LOCAL_URL=http://localhost:8080/invocations
EXECUTOR_LOCAL_URL=http://localhost:8081/invoke
DEBUG_API_URL=http://localhost:8085  DEBUG_API_TOKEN=local-debug-token
HOUSEHOLD_BY_SUB={"*":"hh_demo"}
BUTLER_NOW=<optional ISO time to pin "now" for demos and tests>
```

### LLM modes (`LLM_MODE`)
| Mode | Behaviour | Used for |
|---|---|---|
| `offline` (default in tests/CI) | Deterministic: keyword needs pass, scripted planner, pattern-based rule drafter, heuristic tool router in the simulator | tests, CI, deterministic rehearsals |
| `bedrock` | Real models via Bedrock Converse in `us-east-1`: fast = `us.amazon.nova-2-lite-v1:0` (`BEDROCK_MODEL_FAST`), planner/drafter = `us.amazon.nova-2-lite-v1:0` (`BEDROCK_MODEL_PLANNER`), simulator brain = fast model (`BEDROCK_MODEL_BRAIN`). Uses the developer's real AWS credentials via the default credential chain (so do **not** export the moto dummy keys into these processes; moto clients get explicit `endpoint_url` + dummy credentials passed in code) | real runs, evals, recording |

Rule: both modes implement the same interface; code never branches on mode outside the factory that picks the implementation.

Cost discipline: Bedrock calls only from `bedrock`-mode runs and `@pytest.mark.bedrock` / `vitest` `bedrock` tests, which are **skipped unless `RUN_BEDROCK_TESTS=1`**, and keep prompts small.

## 2. Storage shape

Single table per contracts §10. **Every item is `{PK, SK, [GSI1PK, GSI1SK], type, data, [ttl]}` where `data` is the entity as a JSON string** (UTF-8, `snake_case` fields exactly as in the contracts). Key layouts are in `libs/butler_actions/butler_actions/store.py` (Python, written first) and must be mirrored exactly by the TypeScript repository in `server/src/lib/repo.ts`. Cross-language test: write with one, read with the other (see M-2 / A-8 integration tests).

## 3. Python module APIs (workspace packages, import names)

### `butler_contracts.models`: Pydantic models generated from `packages/contracts/schemas/butler.schema.json`. Regenerate with `pnpm contracts:gen`.

### `butler_actions` (libs/butler_actions): **owner: Workstream A**
Already present: `ids.new_id(prefix)`, `clock.now()/iso()/set_now()`, `store.Store` (+ tests).
To build:
```python
# gateway.py
@dataclass
class GatewayResponse:
    status: Literal["ok", "denied", "error"]
    data: dict | None        # tool result payload when ok
    error: dict | None       # {"code","message"} when error/denied
    request_id: str | None
class GatewayClient(Protocol):
    def call(self, principal: PrincipalName, tool: str, args: dict) -> GatewayResponse: ...
class HttpGatewayClient:     # JSON-RPC tools/call over HTTP; bearer from a token provider per principal
    def __init__(self, url: str, tokens: dict[PrincipalName, Callable[[], str]]): ...
def classify_gateway_response(http_status: int, body: dict) -> GatewayResponse   # tolerant of several denial shapes (see §5)

# wrapper.py   (contracts §8)
@dataclass
class ActionOutcome:
    status: Literal["executed","held_for_approval","blocked","failed"]
    receipt: Receipt
    data: dict | None
    denied_rule: dict | None  # {"rule_id","rule_text","effect"}
def call_action(principal, tool, args, *, household_id, correlation_id, plan_id=None, need_id=None,
                decision_id=None, store: Store, gateway: GatewayClient, rules: list[Rule] | None = None,
                ids: Identities | None = None) -> ActionOutcome
def agent_tool_text(outcome: ActionOutcome) -> str    # "EXECUTED: …" / "DENIED by rule \"…\" (ask_first)" / "FAILED: …"

# scoring.py   might_disagree(store, household_id, tool, args, reasoning, now) -> {"score","top_reason"}  (contracts §8.1)
# summaries.py spoken_summary(tool, status, args, result, reasons, rule_texts) -> str   (contracts §15)
# lint.py      lint_spoken(text) -> list[str]  # violations
```

### `butler_rules` (libs/butler_rules): **owner: Workstream A**
```python
@dataclass(frozen=True)
class Identities: agent_sub: str; executor_sub: str; gateway_arn: str
    @staticmethod
    def local() -> "Identities"          # agent_sub="local-agent", executor_sub="local-executor", gateway_arn="arn:aws:bedrock-agentcore:us-east-1:000000000000:gateway/local"
TEMPLATES: dict[TemplateId, TemplateSpec]     # param schema, effect, text builder, cedar builder
def validate_params(template, params) -> None            # raises RuleParamError
def compile_rule(rule: Rule, ids: Identities) -> str     # Cedar text; every policy has @id("<rule_id>")
def base_policy(ids: Identities) -> str                   # contracts §9.2
def draft_to_rule(draft: RuleDraft, household_id: str, *, origin: RuleOrigin, now: str) -> Rule
def default_rules(household_id: str, ids: Identities, now: str) -> list[Rule]     # contracts §9.4
def match(rules: list[Rule], principal: PrincipalName, tool: str, args: dict) -> MatchResult
    # MatchResult(decision: "ALLOW"|"DENY", rule_ids: list[str], rule_texts: list[str], effects: list[RuleEffect])
class CedarEvaluator:                                      # real Cedar via cedarpy (local gateway + parity tests)
    def __init__(self, rules: list[Rule], ids: Identities): ...
    def authorize(self, principal: PrincipalName, tool: str, args: dict) -> tuple[Literal["ALLOW","DENY"], list[str]]
class PolicyService(Protocol):                             # contracts §5 apply_rule / remove_rule
    def create(self, rule: Rule) -> Rule        # returns rule with policy_id + policy_status="active"
    def disable(self, rule: Rule) -> Rule
class LocalPolicyService: ...                  # activates a rule after a short simulated delay; stores to Store
class AgentCorePolicyService: ...              # boto3 bedrock-agentcore-control create_policy/get_policy/delete_policy; NOT exercised without AWS
```

### `butler_action_handlers` (actions/): **owner: Workstream B**
```python
def dispatch(tool: str, event: dict, *, store: Store, now: datetime | None = None,
             adapters: Adapters | None = None) -> dict
    # tool = "Supplies___checkout" etc. Returns {"ok": True, "data": {...}} or {"ok": False, "error": {"code": "...", "message": "..."}}
    # Validates event against the contract input schema, re-validates every policy-relevant field (contracts §7),
    # is idempotent on event["idempotency_key"], and writes ORDER#/BOOKING#/EVENT# records.
@dataclass
class Adapters: email: EmailAdapter; calendar: CalendarAdapter; payments: PaymentAdapter; weather: WeatherAdapter
def default_adapters(mode: Literal["fake","real"] | None = None) -> Adapters   # env ADAPTERS=fake|real, default fake
```
Fake adapters are deterministic, record everything they "send" (so tests and the demo can show it), and never touch the network. Real adapters: SES (boto3), Google Calendar (REST with refresh token), Stripe/Paystack test mode (REST), Open-Meteo (HTTP; real by default even in fake mode with 3 s timeout and a cached fallback).

### `butler_agent` (agent/): **owner: Workstream B**
```python
def handle(request: dict) -> dict                      # router for AgentRequest → AgentResponse (contracts §5)
class Planner(Protocol): def run(self, ctx: RunContext) -> None        # execution loop; offline = ScriptedPlanner, bedrock = StrandsPlanner
class RuleDrafter(Protocol): def draft(self, correction: str, ctx) -> RuleDraft   # offline = PatternRuleDrafter, bedrock = LLMRuleDrafter
```
HTTP: `butler_agent.server` (Starlette) `POST /invocations` (AgentRequest JSON → AgentResponse JSON; async ops return immediately and continue in a background thread), `GET /ping`.

### `butler_executor` (executor/): **owner: Workstream A**
`handler(request: ExecutorRequest dict) -> dict` (Lambda-style) + `butler_executor.server` (`POST /invoke`).

### `butler_local` (local/): **owner: Workstream A**
`devdb` (moto server + create table), `gateway` (emulator), `dev` (process supervisor), `seed` (loader; also reachable as `seed/load.py`).

## 4. Local Gateway emulator behaviour (must mimic AgentCore closely)

- MCP-ish JSON-RPC 2.0 over `POST /mcp`: `initialize`, `tools/list` (names `Target___tool` with inline schemas from the contracts), `tools/call`.
- Auth: `Authorization: Bearer <token>` → principal via the static token map above; unknown → HTTP 401.
- Before dispatch: evaluate the household's **active** rules with `CedarEvaluator` (real Cedar, ENFORCE, default-deny + base permit). DENY response shape is configurable via `DENY_STYLE` (`jsonrpc_error` default | `tool_error` | `http_403`) so `classify_gateway_response` is proven against all plausible real shapes; the real shape is captured in spike S-1 and then fixed. Policy changes take effect after a configurable propagation delay (`POLICY_DELAY_MS`, default 800) to mimic eventual consistency.
- Allowed → `butler_action_handlers.dispatch(...)`; return the MCP `CallToolResult` shape with `structuredContent` = handler result and `isError` for `ok:false`.
- Household for cedar evaluation comes from the `X-Butler-Household` header the wrapper sets (local only; in AWS the rules are bound to the Gateway's single policy engine and there is one demo household).

## 5. Denial shapes `classify_gateway_response` must accept (until S-1 pins the real one)

1. HTTP 403 with any JSON body.
2. JSON-RPC `error` with a code in {-32001, -32002, -32003} or a message containing "denied", "not authorized", "AccessDenied" or "Policy".
3. JSON-RPC `result` with `isError: true` and text containing the same markers.

Everything else with `isError: true` is a `failed` (Lambda/provider error), not a denial.

## 6. TypeScript module map: **owner: Workstream C** (server) / **D** (simulator)

```
server/src/
  index.ts              HTTP entry (Streamable HTTP, stateless) on :8000/mcp
  server.ts             createServer(deps): registers tools + ui resources
  deps.ts               Deps { repo, agent, executor, needsPass, now, newId, config } — everything injectable for tests
  tools/*.ts            one file per tool (contracts §3)
  lib/{envelope,errors,resolver,lintSpoken,repo,ids,time,agentClient,executorClient,needsPass}.ts
  ui/                   Vite project; src/views/{plan,options,receipt,actions,rule,rules}.tsx + tokens.css
addon-sim/              separate package (own package.json); no imports from butler workspace packages
```
`repo` (TS) implements the same key layout as `store.py` (§2). Tests use an in-memory `Repo` implementation (same interface) and one integration test against the moto server when `DYNAMODB_ENDPOINT` is reachable.

## 7. Test expectations (every workstream)

- Unit tests for every module; table-driven where the contracts give tables.
- Python: `uv run pytest <package>`; TS: `pnpm --filter <pkg> test` (vitest).
- No test may call AWS (other than moto) or the network unless marked `bedrock`/`integration` and skipped by default.
- Every workstream ends by listing, in its final report: what's built, what's verified (with the command), what's mocked/unverified, and any contract deviations (also appended to `handoff/CONTRACT-REQUESTS.md`).
