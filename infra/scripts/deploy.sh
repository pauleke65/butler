#!/usr/bin/env bash
# Ordered deployment steps for one stage. By default this ONLY PRINTS the commands (nothing touches AWS):
#
#   bash infra/scripts/deploy.sh                       # print the plan for BUTLER_STAGE (default dev)
#   BUTLER_STAGE=demo bash infra/scripts/deploy.sh     # ... for the demo stage
#   bash infra/scripts/deploy.sh --yes                 # actually run steps 1-7 (needs AWS credentials)
#   bash infra/scripts/deploy.sh --yes --bootstrap     # ... and also `cdk bootstrap` (once per account/region)
#
# Required for --yes:  SES_FROM_ADDRESS (an inbox you control)  and  BUDGET_EMAIL
# Optional:            BUTLER_STAGE=dev|demo, SES_RECIPIENTS=a@x,b@y, EXTRA_CDK_ARGS="-c adapters=fake"
# `cdk deploy` still asks you to confirm IAM / security-group changes; that prompt is intentionally kept.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE="${BUTLER_STAGE:-dev}"
REGION="us-east-1"
RUN=0; BOOTSTRAP=0
for arg in "$@"; do
  case "$arg" in
    --yes) RUN=1 ;;
    --bootstrap) BOOTSTRAP=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$STAGE" == "dev" || "$STAGE" == "demo" ]] || { echo "BUTLER_STAGE must be dev or demo" >&2; exit 2; }

CTX=(-c "stage=$STAGE")
[[ -n "${SES_FROM_ADDRESS:-}" ]] && CTX+=(-c "SES_FROM_ADDRESS=$SES_FROM_ADDRESS")
[[ -n "${SES_RECIPIENTS:-}" ]] && CTX+=(-c "sesRecipients=$SES_RECIPIENTS")
[[ -n "${BUDGET_EMAIL:-}" ]] && CTX+=(-c "budgetEmail=$BUDGET_EMAIL")
# shellcheck disable=SC2206
[[ -n "${EXTRA_CDK_ARGS:-}" ]] && CTX+=(${EXTRA_CDK_ARGS})

if [[ $RUN -eq 1 ]]; then
  : "${SES_FROM_ADDRESS:?set SES_FROM_ADDRESS to an inbox you control (SES sends a verification mail there)}"
  : "${BUDGET_EMAIL:?set BUDGET_EMAIL for the \$50 / \$100 budget alarms}"
fi

STEPS=()
step() { STEPS+=("$1"); }

if [[ $BOOTSTRAP -eq 1 || $RUN -eq 0 ]]; then
  step "# 0. ONCE per account+region (creates the CDK toolkit stack and asset bucket). Only run with --yes --bootstrap.
cd '$ROOT/infra' && npx cdk bootstrap aws://\$(aws sts get-caller-identity --query Account --output text)/$REGION"
fi
step "# 1. dependencies
cd '$ROOT' && pnpm install && uv sync --python 3.12"
step "# 2. offline checks (no AWS): types, unit tests, policy drift test
cd '$ROOT/infra' && pnpm typecheck && pnpm test && cd '$ROOT' && uv run pytest infra/runtime/tests actions/tests/test_actions_lambda_handler.py executor/tests/test_executor_lambda_handler.py -q"
step "# 3. build Lambda + Runtime assets (no Docker): infra/dist/*
cd '$ROOT/infra' && pnpm build:lambdas && pnpm build:runtimes"
step "# 4. synthesize (no AWS calls beyond reading your account id)
cd '$ROOT/infra' && npx cdk synth ${CTX[*]} -q"
step "# 5. DEPLOY (creates real resources; cdk asks you to confirm IAM changes)
cd '$ROOT/infra' && npx cdk deploy butler-$STAGE ${CTX[*]}"
step "# 6. MANUAL, one time (see infra/README.md): click the SES verification mail; put the Google refresh token JSON and the
#    payment TEST key into Secrets Manager (butler/$STAGE/google-refresh-token, butler/$STAGE/payment-key); enable Bedrock
#    model access; rotate the debug API token before recording. Until then you can run with: -c adapters=fake"
step "# 7. seed the real table and link the default rules to the deployed policies
cd '$ROOT' && uv run python infra/scripts/seed_aws.py --stage $STAGE"

if [[ $RUN -eq 0 ]]; then
  echo "DRY RUN: nothing was executed. Plan for stage '$STAGE' ($REGION):"
  echo
  printf '%s\n\n' "${STEPS[@]}"
  echo "Re-run with --yes to execute (set SES_FROM_ADDRESS and BUDGET_EMAIL first)."
  exit 0
fi

echo "Running the deployment for stage '$STAGE' in $REGION ..."
for s in "${STEPS[@]}"; do
  echo
  echo "$s" | grep '^#' || true
  cmd="$(echo "$s" | grep -v '^#' || true)"
  [[ -z "$cmd" ]] && { read -r -p "Manual step above done? Press Enter to continue (Ctrl-C to stop) " _; continue; }
  echo "+ $cmd"
  bash -c "$cmd"
done
