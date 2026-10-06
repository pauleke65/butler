#!/usr/bin/env bash
# Start/stop the whole local stack (backend supervisor + MCP server). Usage: scripts/stack.sh start|stop|status|restart
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=.local-data; mkdir -p "$RUN"

port_pid() { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true; }

stop() {
  for f in server dev; do
    [ -f "$RUN/$f.pid" ] && kill "$(cat "$RUN/$f.pid")" 2>/dev/null || true
    rm -f "$RUN/$f.pid"
  done
  p=$(port_pid 8000); [ -n "$p" ] && kill "$p" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8; do
    left=""; for port in 5555 8090 8080 8081 8085 8000; do [ -n "$(port_pid $port)" ] && left="$left $port"; done
    [ -z "$left" ] && return 0; sleep 1
  done
  for port in 5555 8090 8080 8081 8085 8000; do p=$(port_pid $port); [ -n "$p" ] && kill -9 "$p" 2>/dev/null || true; done
}

start() {
  stop
  LLM_MODE="${LLM_MODE:-offline}" nohup uv run python -m butler_local.dev > "$RUN/dev.log" 2>&1 & echo $! > "$RUN/dev.pid"
  for i in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:8081/ 2>/dev/null && curl -s -o /dev/null http://127.0.0.1:8080/ 2>/dev/null && break; sleep 0.5; done
  pnpm --filter ./server/ui build > "$RUN/ui-build.log" 2>&1 || { echo "ui build failed, see $RUN/ui-build.log"; exit 1; }
  STAGE=local DYNAMODB_ENDPOINT=http://localhost:5555 AGENT_LOCAL_URL=http://localhost:8080/invocations \
    EXECUTOR_LOCAL_URL=http://localhost:8081/invoke LLM_MODE="${LLM_MODE:-offline}" \
    nohup pnpm --filter ./server start > "$RUN/server.log" 2>&1 & echo $! > "$RUN/server.pid"
  for i in $(seq 1 40); do curl -sf http://127.0.0.1:8000/healthz >/dev/null && break; sleep 0.5; done
  status
}

status() {
  for port in 5555 8090 8080 8081 8085 8000; do printf "%s:%s " "$port" "$([ -n "$(port_pid $port)" ] && echo up || echo DOWN)"; done; echo
}

case "${1:-status}" in start) start;; stop) stop;; restart) start;; status) status;; *) echo "usage: $0 start|stop|status|restart"; exit 2;; esac
