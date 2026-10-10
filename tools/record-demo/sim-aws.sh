#!/usr/bin/env bash
# Starts the simulator (addon-sim) against the deployed Butler stack instead of the local one:
#   - MCP server on AgentCore Runtime, called with a short-lived Cognito machine token (sim client);
#   - the Black Box panel reading the deployed debug API.
# Tokens are fetched at run time and live only in this process's environment.
#   STAGE=dev AWS_PROFILE=pie tools/record-demo/sim-aws.sh
set -euo pipefail
STAGE="${STAGE:-dev}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# home-router DNS sometimes drops AWS lookups for a minute: retry every network step
retry() { local n=0; until "$@" 2>/dev/null; do n=$((n + 1)); [ "$n" -ge 24 ] && return 1; sleep 8; done; }
# resolve via the nameserver directly (dig), bypassing a stale negative entry in the system cache
pin() { local host ip; host="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).hostname)' "$1")"; ip="$(dig +short +time=3 "$host" | grep -E '^[0-9.]+$' | head -1)"; [ -n "$ip" ] && echo "--resolve $host:443:$ip"; }
P() { retry aws ssm get-parameter --name "/butler/$STAGE/$1" --query Parameter.Value --output text; }
S() { retry aws secretsmanager get-secret-value --secret-id "butler/$STAGE/$1" --query SecretString --output text; }

MCP_URL="$(P mcp-server-url)"
TOKEN_URL="$(P cognito/token-url)"
CLIENT_ID="$(P cognito/sim-client-id)"
SCOPE="$(P cognito/scope)"
CLIENT_SECRET="$(S sim-client)"
JWT=""
for _ in 1 2 3 4 5 6 7 8; do
  # shellcheck disable=SC2046
  JWT="$(curl -sf $(pin "$TOKEN_URL") -u "$CLIENT_ID:$CLIENT_SECRET" -d "grant_type=client_credentials&scope=$SCOPE" "$TOKEN_URL" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null || true)"
  [ -n "$JWT" ] && break
  sleep 5
done
[ -n "$JWT" ] || { echo "could not get a Cognito token" >&2; exit 1; }
DEBUG_API_URL="$(P debug-api/url)"
DEBUG_API_TOKEN="$(S debug-api-token)"

SIM_SERVERS="$(python3 -c 'import json,sys;print(json.dumps([{"id":"butler","name":"Butler","url":sys.argv[1],"auth":{"type":"bearer","token":sys.argv[2]},"invocationName":"Butler","enabled":True}]))' "$MCP_URL" "$JWT")"

for port in 3000 3001; do pid=$(lsof -tiTCP:$port -sTCP:LISTEN 2>/dev/null | head -1 || true); [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
sleep 1
cd "$root/addon-sim"
export SIM_SERVERS DEBUG_API_URL="${DEBUG_API_URL%/}" DEBUG_API_TOKEN PANEL_URLS="${PANEL_URLS:-http://localhost:3002/panel.js}"
export NODE_OPTIONS="--require $here/dns-fallback.cjs ${NODE_OPTIONS:-}"
nohup pnpm dev > "${SIM_LOG:-/tmp/butler-sim-aws.log}" 2>&1 &
echo "simulator starting on http://localhost:3000 against $STAGE (token valid about 1 hour)"
