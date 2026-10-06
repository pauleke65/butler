#!/usr/bin/env bash
# Build the three Lambda assets into infra/dist/{actions,executor,debug-api} WITHOUT Docker.
#
#   bash infra/scripts/build-lambdas.sh            (or: cd infra && pnpm build:lambdas)
#
# Third-party wheels are resolved for Lambda's platform (linux aarch64, CPython 3.12) with `uv pip install --target`;
# the workspace packages are pure Python and are copied as source. boto3/botocore are NOT bundled (the Lambda
# Python 3.12 runtime provides them). Needs: uv, network access to PyPI (wheels are cached by uv).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${DIST_DIR:-$ROOT/infra/dist}"
PLATFORM_FLAGS=(--python-platform aarch64-manylinux2014 --python-version 3.12 --only-binary :all: --no-compile)

command -v uv >/dev/null 2>&1 || { echo "error: uv is required (https://docs.astral.sh/uv/)" >&2; exit 1; }

copy_pkg() { # <source dir of the python package> <dest dir>
  mkdir -p "$2"
  rsync -a --delete --exclude '__pycache__' --exclude '*.pyc' --exclude '.pytest_cache' "$1" "$2/"
}

prune() { # drop bytecode and test folders vendored by dependencies
  find "$1" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  find "$1" -type d \( -name tests -o -name test \) -path '*/site-packages/*' -prune -exec rm -rf {} + 2>/dev/null || true
}

build() { # <name> <third-party requirement>... ; packages are listed in $PKGS (src dirs)
  local name="$1"; shift
  local out="$DIST/$name"
  echo "==> $name"
  rm -rf "$out"; mkdir -p "$out"
  uv pip install --quiet --target "$out" "${PLATFORM_FLAGS[@]}" "$@"
  for src in "${PKGS[@]}"; do copy_pkg "$ROOT/$src" "$out"; done
  rm -rf "$out/bin"   # console scripts of the wheels (httpx, uvicorn, ...) are not needed
  prune "$out"
}

mkdir -p "$DIST"

# --- actions: serves all five Gateway targets (no cedarpy / butler_rules needed; a unit test guards the import graph)
PKGS=(packages/contracts/py/butler_contracts libs/butler_actions/butler_actions actions/butler_action_handlers)
build actions "pydantic>=2.7" "httpx>=0.27" "tzdata"
mkdir -p "$DIST/actions/butler_action_handlers/data"
cp "$ROOT"/seed/*.json "$DIST/actions/butler_action_handlers/data/"   # catalogue + providers (seeddata.py looks in ./data first)

# --- executor: butler_actions.wrapper imports butler_rules, which needs cedarpy (aarch64 wheel)
PKGS=(packages/contracts/py/butler_contracts libs/butler_rules/butler_rules libs/butler_actions/butler_actions actions/butler_action_handlers executor/butler_executor)
build executor "pydantic>=2.7" "httpx>=0.27" "tzdata" "cedarpy>=4"
mkdir -p "$DIST/executor/butler_action_handlers/data"
cp "$ROOT"/seed/*.json "$DIST/executor/butler_action_handlers/data/"

# --- debug API: only reads the table
PKGS=(packages/contracts/py/butler_contracts libs/butler_actions/butler_actions debug-api/debug_api)
build debug-api "pydantic>=2.7" "tzdata"

echo "done:"; du -sh "$DIST"/actions "$DIST"/executor "$DIST"/debug-api
