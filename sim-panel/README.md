# Butler Black Box panel (`sim-panel`)

An [addon-sim](../addon-sim) panel plugin for the Butler demo. It polls the Butler debug API every second and shows a live feed of every policy decision (tool, principal, ALLOW or DENY, the rule text, amount) plus the active rules, with newly created rules highlighted. A DENY flashes red when it arrives.

```bash
pnpm install --ignore-workspace      # standalone while the root workspace is not installed
pnpm build                           # dist/panel.js (single ES module, no dependencies)
pnpm serve                           # http://localhost:3002/panel.js (CORS enabled)
pnpm mock-api -- --demo              # stand-in debug API on :8085 that replays the golden-demo moments
# then, in addon-sim:
PANEL_URLS=http://localhost:3002/panel.js DEBUG_API_URL=http://localhost:8085 DEBUG_API_TOKEN=local-debug-token pnpm dev
```

Config comes from the simulator's `ctx.env` (`DEBUG_API_URL`, default `http://localhost:8085`; `DEBUG_API_TOKEN`, default `local-debug-token`). Requests go through the simulator's allow-listed proxy, so the debug API needs no CORS headers. `pnpm test` covers the feed logic, the poller (against the mock API over HTTP) and the rendered DOM.

The mock API (`mock/debug-api.mjs`) also accepts `POST /__mock/receipt`, `POST /__mock/rule` and `POST /__mock/reset` (same bearer token) for manual testing.
