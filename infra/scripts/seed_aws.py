"""Seed the REAL (deployed) table and link the default rules to the policies CDK created.

Run once after `cdk deploy`, from the repo root, with AWS credentials (it reads SSM and writes ONE DynamoDB table):

    uv run python infra/scripts/seed_aws.py --stage dev [--reset]

Why not just `python seed/load.py`? That loader targets the local moto table and records fake policy ids
(`local-<rule_id>`); against AWS the default rules must point at the real AgentCore policies that CDK deployed (same
names, `policy_name(rule_id)`), otherwise `remove_rule` / `change_rule` on a default rule would try to delete a policy
that does not exist and the real one would keep enforcing. This wrapper reuses the loader (household, contacts,
history, default rules compiled with the REAL Cognito client ids) and then fixes up the policy ids.
"""
from __future__ import annotations

import argparse
import logging
import os
from typing import Any

from butler_actions.store import Store
from butler_local.seed import seed
from butler_rules import DEFAULT_RULE_IDS, Identities
from butler_rules.policy_service import policy_name

log = logging.getLogger("butler.seed_aws")


def ssm_values(ssm: Any, stage: str) -> dict[str, str]:
    """All parameters under /butler/{stage}/ keyed by their path relative to it."""
    prefix = f"/butler/{stage}/"
    out: dict[str, str] = {}
    token: str | None = None
    while True:
        res = ssm.get_parameters_by_path(Path=prefix, Recursive=True, **({"NextToken": token} if token else {}))
        out.update({p["Name"][len(prefix):]: p["Value"] for p in res["Parameters"]})
        token = res.get("NextToken")
        if not token:
            return out


def policies_by_name(client: Any, engine_id: str) -> dict[str, str]:
    found: dict[str, str] = {}
    token: str | None = None
    while True:
        res = client.list_policies(policyEngineId=engine_id, **({"nextToken": token} if token else {}))
        found.update({p["name"]: p["policyId"] for p in res.get("policies", [])})
        token = res.get("nextToken")
        if not token:
            return found


def remove_demo_policies(client: Any, engine_id: str, timeout_s: float = 120) -> list[str]:
    """Delete rule policies that demo runs created (corrections turned into rules). Keeps the base permit and the
    default rules' policies. Without this a reset clears the table but the old rules keep enforcing at the gateway."""
    import time

    keep = {policy_name(rule_id) for rule_id in DEFAULT_RULE_IDS}
    stale = {name: pid for name, pid in policies_by_name(client, engine_id).items() if name.startswith("rule_") and name not in keep}
    for name, pid in stale.items():
        client.delete_policy(policyEngineId=engine_id, policyId=pid)
        log.info("deleted demo policy %s", name)
    deadline = time.monotonic() + timeout_s
    while stale and time.monotonic() < deadline and set(stale) & set(policies_by_name(client, engine_id)):
        time.sleep(3)
    return sorted(stale)


def link_default_policies(store: Store, household_id: str, client: Any, engine_id: str) -> list[str]:
    """Point each default rule record at its deployed policy. Returns the rule ids that were linked."""
    deployed = policies_by_name(client, engine_id)
    linked: list[str] = []
    missing: list[str] = []
    for rule_id in DEFAULT_RULE_IDS:
        rule = store.get_rule(household_id, rule_id)
        policy_id = deployed.get(policy_name(rule_id))
        if rule is None or policy_id is None:
            missing.append(rule_id)
            continue
        store.put_rule(rule.model_copy(update={"policy_id": policy_id, "policy_status": "active", "active": True}))
        linked.append(rule_id)
    if missing:
        raise SystemExit(f"default rules without a deployed policy or record: {', '.join(missing)} (did `cdk deploy` finish?)")
    return linked


def main(argv: list[str] | None = None) -> None:
    import boto3

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--stage", choices=["dev", "demo"], default="dev")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--reset", action="store_true", help="clear demo state first (keeps household, contacts, default rules)")
    args = parser.parse_args(argv)

    from botocore.config import Config

    # a stray local-moto endpoint must never leak into a run against AWS
    os.environ.pop("DYNAMODB_ENDPOINT", None)
    retrying = Config(retries={"max_attempts": 10, "mode": "standard"})  # rides out brief DNS / network drops
    values = ssm_values(boto3.client("ssm", region_name=args.region, config=retrying), args.stage)
    ids = Identities(values["cognito/agent-client-id"], values["cognito/executor-client-id"], values["gateway/arn"])
    store = Store(values["table-name"], args.region)
    summary = seed(store, do_reset=args.reset, ids=ids)
    control = boto3.client("bedrock-agentcore-control", region_name=args.region, config=retrying)
    if args.reset:
        remove_demo_policies(control, values["policy-engine/id"])
    linked = link_default_policies(store, summary["household_id"], control, values["policy-engine/id"])
    log.info("seeded %s into %s: %d history receipts, %d default rules linked to deployed policies",
             summary["household_id"], values["table-name"], summary["receipts"], len(linked))


if __name__ == "__main__":
    main()
