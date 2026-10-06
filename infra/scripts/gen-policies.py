"""Print {rule_id: cedar} for the Gateway policy engine, compiled by the REAL rule compiler (libs/butler_rules).

    cd infra && pnpm gen:policies

The output holds the base permit (contracts 9.2) and the five default rules (contracts 9.4). Cognito client ids are
only known at deploy time, so the identities are the placeholders {{AGENT_SUB}} / {{EXECUTOR_SUB}} (the same ones the
golden files in policies/golden use); CDK substitutes them with the client-id tokens at synth time.
"""
from __future__ import annotations

import json
import sys

from butler_rules import Identities, base_policy, default_rules

PLACEHOLDER_IDS = Identities(
    agent_sub="{{AGENT_SUB}}",
    executor_sub="{{EXECUTOR_SUB}}",
    gateway_arn="arn:aws:bedrock-agentcore:us-east-1:000000000000:gateway/placeholder",  # not used by any template
)
FIXED_NOW = "2026-01-01T00:00:00+00:00"  # timestamps are not part of the Cedar text


def generate() -> dict[str, str]:
    policies = {"base-permit": base_policy(PLACEHOLDER_IDS)}
    for rule in default_rules("hh_demo", PLACEHOLDER_IDS, FIXED_NOW):
        if not rule.cedar_statement:
            raise SystemExit(f"rule {rule.rule_id} compiled to nothing")
        policies[rule.rule_id] = rule.cedar_statement
    for rule_id, cedar in policies.items():
        if f'@id("{rule_id}")' not in cedar:
            raise SystemExit(f"policy {rule_id} lacks its @id annotation")
    return policies


def main() -> None:
    sys.stdout.write(json.dumps(generate(), indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
