#!/usr/bin/env bash
# Build the two AgentCore Runtime code assets WITHOUT Docker:
#   infra/dist/agent-runtime/   Python 3.12 arm64 deps + workspace packages + prompts + agent_entry.py
#   infra/dist/server-runtime/  esbuild bundle of server/ (Node 22) + built MCP Apps views (ui/)
#
#   bash infra/scripts/build-runtimes.sh [agent|server]      (default: both)
#
# Needs: uv, pnpm (workspace installed: `pnpm install` at the repo root), network access to PyPI.
# If AgentCore direct code deployment turns out not to work for you, use `-c runtimeArtifact=container`
# (agent/Dockerfile + server/Dockerfile, which need Docker) - see infra/README.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${DIST_DIR:-$ROOT/infra/dist}"
WHAT="${1:-all}"
PLATFORM_FLAGS=(--python-platform aarch64-manylinux2014 --python-version 3.12 --only-binary :all: --no-compile)

build_agent() {
  command -v uv >/dev/null 2>&1 || { echo "error: uv is required" >&2; exit 1; }
  local out="$DIST/agent-runtime"
  echo "==> agent-runtime"
  rm -rf "$out"; mkdir -p "$out"
  # boto3 IS bundled here (unlike the Lambdas): the managed runtime does not provide it.
  uv pip install --quiet --target "$out" "${PLATFORM_FLAGS[@]}" \
    "pydantic>=2.7" "httpx>=0.27" "boto3>=1.35" "starlette>=0.40" "uvicorn>=0.30" "pyyaml>=6" "cedarpy>=4" "tzdata"
  for src in packages/contracts/py/butler_contracts libs/butler_rules/butler_rules libs/butler_actions/butler_actions \
             actions/butler_action_handlers agent/butler_agent; do
    rsync -a --exclude '__pycache__' --exclude '*.pyc' "$ROOT/$src" "$out/"
  done
  mkdir -p "$out/butler_action_handlers/data" "$out/prompts"
  cp "$ROOT"/seed/*.json "$out/butler_action_handlers/data/"
  cp "$ROOT"/prompts/*.md "$out/prompts/"          # butler_agent.prompts finds ./prompts next to the package
  cp "$ROOT/infra/runtime/agent_entry.py" "$out/agent_entry.py"
  rm -rf "$out/bin"
  find "$out" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  du -sh "$out"
}

build_server() {
  command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required" >&2; exit 1; }
  local out="$DIST/server-runtime"
  echo "==> server-runtime"
  rm -rf "$out"; mkdir -p "$out/ui"
  (cd "$ROOT" && pnpm --filter ./server/ui build)    # single-file HTML views -> server/ui/dist
  cp "$ROOT"/server/ui/dist/*.html "$out/ui/"
  # One ESM bundle (the TS workspace package @butler/contracts is inlined). `createRequire` shim for CJS deps.
  "$ROOT/infra/node_modules/.bin/esbuild" "$ROOT/server/src/index.ts" --bundle --platform=node --target=node22 \
    --format=esm --outfile="$out/server.mjs" --log-level=warning \
    --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  # Entry: point the server at the views that sit next to it, then start it (PORT defaults to 8000, path /mcp).
  cat > "$out/entry.mjs" <<'JS'
import { fileURLToPath } from "node:url";
process.env.UI_DIST_DIR ??= fileURLToPath(new URL("./ui", import.meta.url));
await import("./server.mjs");
JS
  du -sh "$out"
}

case "$WHAT" in
  agent) build_agent ;;
  server) build_server ;;
  all) build_agent; build_server ;;
  *) echo "usage: $0 [agent|server]" >&2; exit 2 ;;
esac
