# Butler MCP server and views (Workstream C)

The Alexa-facing MCP server: TypeScript, **stateless Streamable HTTP** on `:8000/mcp` (plus `GET /healthz`), nine tools
and two app-only helpers (contracts §3), and six MCP Apps views (`ui://butler/*`, contracts §4).

| | |
|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` 1.32.1 (v1 line; `latest` on npm) |
| MCP Apps | `@modelcontextprotocol/ext-apps` 1.7.5 (`registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`) |
| Protocol | negotiates **2025-11-25** with current clients; also accepts 2025-06-18 and 2025-03-26 (what Alexa+ sends today) |
| Server identity | name `butler`, version `0.1.0` |

## Run it locally

```bash
pnpm install                          # from the repo root
pnpm --filter ./server dev            # tsx watch, http://localhost:8000/mcp
pnpm --filter ./server/ui build       # builds the six views (or `pnpm --filter ./server build`)
```

With the Python stack (`make dev`: moto on :5555, gateway, agent :8080, executor :8081, then `make seed`) the server
needs nothing but the defaults from `05-local-build.md` §1:

```bash
STAGE=local DYNAMODB_ENDPOINT=http://localhost:5555 AGENT_LOCAL_URL=http://localhost:8080/invocations \
  EXECUTOR_LOCAL_URL=http://localhost:8081/invoke pnpm --filter ./server dev
```

No Python? `pnpm --filter ./server dev:fixtures` runs the **real server and tools** on `:8001` over an in-memory repo seeded
from `packages/contracts/fixtures`, with scripted stand-ins for the agent and approval executor.

Smoke test:

```bash
curl -s localhost:8000/healthz
curl -s localhost:8000/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer local-sim-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_rules","arguments":{}}}'
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | listen port (binds `0.0.0.0`) |
| `STAGE` | `local` | `local`: no auth or `Bearer local-sim-token`; anything else requires a bearer token |
| `HOUSEHOLD_BY_SUB` | `{"*":"hh_demo"}` | token `sub` (or `client_id`) to household; `"*"` is the fallback. Never taken from tool input |
| `AWS_REGION` | `us-east-1` | |
| `TABLE_NAME` | `butler-local` | DynamoDB table (layout mirrors `store.py`) |
| `DYNAMODB_ENDPOINT` | unset | local DynamoDB/moto; **only when set** explicit dummy credentials are used |
| `AGENT_LOCAL_URL` | unset | `POST` agent ops here (local). Else `AGENT_RUNTIME_ARN` -> `InvokeAgentRuntime` (session id >= 33 chars) |
| `EXECUTOR_LOCAL_URL` | unset | `POST` approval executor here (local). Else `EXECUTOR_FUNCTION_NAME` -> Lambda invoke |
| `LLM_MODE` | `offline` | `offline`: keyword needs pass. `bedrock`: Claude Haiku via Converse (real AWS credentials from the default chain, never the moto dummy keys), falls back to keywords |
| `BEDROCK_MODEL_FAST` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | needs-pass model |
| `NEEDS_PASS_TIMEOUT_MS` / `HANDLE_SITUATION_BUDGET_MS` | `2500` / `2500` | Bedrock call timeout / total `handle_situation` budget (the needs pass gets the budget minus 700 ms) |
| `EXECUTOR_TIMEOUT_MS` | `8000` | approval executor timeout |
| `MCP_JSON_RESPONSE` | `true` | reply with JSON instead of an SSE stream |
| `BUTLER_NOW` | unset | pin "now" (ISO) for demos |
| `UI_DIST_DIR` | `server/ui/dist` | where the built views are read from |
| `CORS_ORIGIN` | `*` in `local` | |
| `LOG_LEVEL` | `info` | JSON lines on stderr |

## Tools

All tools return `structuredContent` (`{ok, spoken_summary, ...}`), a text block with the same JSON, and
`_meta.ui.{resourceUri, invoking, invoked}`. Errors are `isError: true` with
`{ok:false, spoken_summary, error:{code, message_spoken, candidates?, details?}}` (codes in contracts §14).

| Tool | View | Notes |
|---|---|---|
| `handle_situation` | plan | fast needs pass (keywords or Bedrock) + plan write + fire-and-forget agent `start_plan`; duplicate plan returns the existing one |
| `get_status` | plan, or options when exactly one `choose_option` is pending | `done_since_last_check` via `Plan.last_status_read_at` |
| `answer_decision` | receipt | ids, ordinals, titles, approve/reject; executor synchronously, then agent `resume_plan`; replay-safe |
| `list_actions` | actions | ranking and filters per §3.5; read-only tool receipts (searches, weather) are excluded |
| `explain_action` | receipt | reference resolver (title, need, recipient, item, tool words, recency boost, <= 3 candidates) |
| `object_to_action` | rule | two-step confirm via the `DRAFT#LATEST` lock; `offered_undo` |
| `list_rules` / `change_rule` | rules / rule | raise a limit (new policy applied, then old removed) or remove, same confirm flow |
| `undo_action` | receipt | `checkout->refund`, `book_service->cancel_booking`, `create_event->delete_event` via the executor |
| `get_ledger_page`, `get_plan` | none | app-only (`_meta.ui.visibility: ["app"]`) |

`outputSchema` is advertised as `oneOf [success, error envelope]`: strict clients (the SDK client included) validate
`structuredContent` against it even on `isError` results.

## Layout

```
src/index.ts        process entry          src/http.ts     stateless Streamable HTTP + auth + CORS
src/server.ts       createServer(deps)     src/deps.ts     Deps { repo, agent, executor, needsPass, now, newId, config, logger, background }
src/tools/*.ts      one file per tool + spec.ts (central runner / error mapper) + rulesFlow.ts
src/lib/            envelope errors resolver choice lintSpoken repo memoryRepo agentClient executorClient
                    needsPass bedrockNeedsPass time ids auth views icons
src/dev/            fixtures, fakes and the fixture server (tests and previews)
ui/                 Vite project, one self-contained HTML file per view
```

Everything outside the process is injected through `Deps`, so tests run on an in-memory table with the same key logic
as DynamoDB (`TableRepo` over a `Table`), a fake agent and a fake executor.

## Views

`ui/` builds `dist/{plan,options,receipt,actions,rule,rules}.html` (Preact + one Vite build per view +
`vite-plugin-singlefile`; 27 to 34 KB each, limit 200 KB). `src/server.ts` serves them from `UI_DIST_DIR` with
`mimeType: "text/html;profile=mcp-app"` (a placeholder page is served if they are not built).

- Each view paints its first frame from `ontoolresult` (`structuredContent`) with no extra fetch; handlers are registered
  before `connect()`; theme follows the host context (dark by default).
- Buttons call tools through the host: Choose -> `answer_decision`, Why? -> `explain_action`, Undo -> `undo_action`,
  Confirm -> `object_to_action {confirm:true}`, Remove -> `change_rule`, See more -> `requestDisplayMode("fullscreen")` +
  `get_ledger_page`.
- `ui/src/bridge.ts` is a small protocol-compatible stand-in for `App` from ext-apps: importing `App` pulls the MCP SDK type
  schemas and zod into every view (445 KB). The fixture preview runs the real `AppBridge` against it.
- Design tokens: `ui/src/tokens.css` (24 px base, 1.6 type scale, 1.25x on a 1920 px screen, status chips, ALLOWED / HELD /
  BLOCKED badges, "Simulated" badge, 64 px touch targets).

Fixture preview (real `AppBridge` host + the real tools over the contract fixtures, buttons really work):

```bash
pnpm --filter ./server/ui preview:fixtures      # builds, starts the fixture server (:8001) and http://127.0.0.1:5180/
pnpm --filter ./server/ui screenshots           # docs/screenshots/*.show8.png (1280x800) and *.show15.png (1920x1080)
```

## Tests

```bash
pnpm --filter ./server test        # vitest: tools, resolver, needs pass, clients, MCP over loopback HTTP, contract, fuzz, key layout
pnpm --filter ./server typecheck
pnpm --filter ./server/ui test     # bundle size/self-contained checks, bridge protocol
```

- `test/storeLayout.test.ts` compares the TS repo's items with `test/golden/store_items.golden.json`, produced by running the
  Python `Store` (regenerate: `uv run python server/test/golden/gen_store_golden.py`). With `DYNAMODB_ENDPOINT` reachable it also
  round-trips against a real table (skipped otherwise).
- Bedrock is never called by tests (a mocked client is used).
