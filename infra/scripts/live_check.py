"""Live checks against a DEPLOYED stage (spike S-1 / ticket P-6): real Cognito tokens, real AgentCore Gateway,
real Cedar policies. Prints the raw denial shape, checks that our matcher agrees with the gateway, and (optionally)
measures how long a newly created rule takes to be enforced.

    AWS_PROFILE=pie uv run python infra/scripts/live_check.py --stage dev [--propagation]

Side effects: writes receipts/orders for household hh_demo in the stage's table (fake adapters: no real money or
email); --propagation creates and then deletes one temporary policy.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from typing import Any

import boto3
import httpx

from butler_actions.gateway import CognitoClientCredentials, HttpGatewayClient, classify_gateway_response
from butler_actions.ids import new_id
from butler_actions.store import Store
from butler_actions.wrapper import call_action

HH = "hh_demo"


def ssm_values(stage: str, region: str) -> dict[str, str]:
    ssm = boto3.client("ssm", region_name=region)
    out: dict[str, str] = {}
    token = None
    while True:
        res = ssm.get_parameters_by_path(Path=f"/butler/{stage}/", Recursive=True, **({"NextToken": token} if token else {}))
        out.update({p["Name"][len(f"/butler/{stage}/"):]: p["Value"] for p in res["Parameters"]})
        token = res.get("NextToken")
        if not token:
            return out


def secret(name: str, region: str) -> str:
    return boto3.client("secretsmanager", region_name=region).get_secret_value(SecretId=name)["SecretString"].strip()


CASES: list[dict[str, Any]] = [
    {"name": "agent: search (read-only)", "principal": "butler-agent", "tool": "Supplies___search_products",
     "args": {"query": "drinks for 7", "category": "drinks"}, "expect": "ALLOW"},
    {"name": "agent: checkout 42 dollars (under cap)", "principal": "butler-agent", "tool": "Supplies___checkout",
     "args": {"merchant": "FreshCart", "items": [{"sku": "drk-party-7", "qty": 1}], "amount_minor": 4200,
              "currency": "USD", "category": "drinks"}, "expect": "ALLOW"},
    {"name": "agent: checkout 58 dollars (over cap)", "principal": "butler-agent", "tool": "Supplies___checkout",
     "args": {"merchant": "Corner Cellar", "items": [{"sku": "drk-premium-7", "qty": 1}], "amount_minor": 5800,
              "currency": "USD", "category": "drinks"}, "expect": "DENY", "raw": True},
    {"name": "executor: checkout 58 dollars (approved)", "principal": "approval-executor", "tool": "Supplies___checkout",
     "args": {"merchant": "Corner Cellar", "items": [{"sku": "drk-premium-7", "qty": 1}], "amount_minor": 5800,
              "currency": "USD", "category": "drinks"}, "expect": "ALLOW"},
    {"name": "agent: email a non-contact", "principal": "butler-agent", "tool": "Messages___send_email",
     "args": {"recipient_email": "stranger@example.org", "subject": "Hi", "body_text": "Hello", "kind": "other"},
     "expect": "DENY"},
    {"name": "agent: book a service (always ask)", "principal": "butler-agent", "tool": "Services___book_service",
     "args": {"provider_id": "prv_tidyup", "service_type": "cleaning", "slot_start": "2026-10-15T09:00:00-04:00",
              "amount_minor": 5900, "currency": "USD"}, "expect": "DENY"},
    {"name": "executor: delete a human event (never)", "principal": "approval-executor", "tool": "Calendar___delete_event",
     "args": {"event_id": "evt_human_demo", "event_owner": "human"}, "expect": "DENY"},
]


def run_cases(gw: HttpGatewayClient, store: Store, tokens: dict[str, Any], url: str) -> list[dict[str, Any]]:
    results = []
    for case in CASES:
        if case.get("raw"):  # capture the exact wire shape of a real denial once
            body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": {"name": case["tool"], "arguments": {**case["args"], "correlation_id": "cor_raw",
                                                                    "idempotency_key": new_id("idem")}}}
            res = httpx.post(url, json=body, headers={"Authorization": f"Bearer {tokens[case['principal']]()}"}, timeout=30)
            print(f"\nRAW DENIAL  HTTP {res.status_code}\n{res.text[:1200]}\n")
            print("classified as:", classify_gateway_response(res.status_code, res.json() if res.content else {}).status)
        out = call_action(case["principal"], case["tool"], dict(case["args"]), household_id=HH,
                          correlation_id=new_id("cor"), store=store, gateway=gw)
        got = out.receipt.authority.decision
        results.append({"case": case["name"], "expected": case["expect"], "gateway": got,
                        "matcher_agrees": out.receipt.authority.matcher_gateway_agree, "status": out.status,
                        "rules": out.receipt.authority.rule_ids, "error": (out.error or {}).get("code") if out.error else None})
    return results


def propagation(store: Store, values: dict[str, str], gw: HttpGatewayClient, region: str) -> None:
    """Create an ask_category rule for 'gifts', poll until the gateway denies, then delete it."""
    from butler_rules import AgentCorePolicyService, Identities
    from butler_rules.compiler import draft_to_rule
    from butler_contracts.models import RuleDraft

    ids = Identities(values["cognito/agent-client-id"], values["cognito/executor-client-id"], values["gateway/arn"])
    svc = AgentCorePolicyService(boto3.client("bedrock-agentcore-control", region_name=region), values["policy-engine/id"],
                                 store=store, validation_mode="IGNORE_ALL_FINDINGS")
    draft = RuleDraft(template="ask_category", params={"category": "gifts"}, text="Ask me before buying gifts.",
                      effect="ask_first", confidence=1.0)
    rule = draft_to_rule(draft, HH, origin={"type": "default"}, now=time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()), ids=ids)
    args = {"merchant": "HomeHub", "items": [{"sku": "gf-card", "qty": 1}], "amount_minor": 900, "currency": "USD",
            "category": "gifts", "correlation_id": "cor_prop"}
    t0 = time.monotonic()
    created = svc.create(rule)
    t_active = time.monotonic() - t0
    print(f"policy {created.policy_id} ACTIVE after {t_active:.1f}s; polling the gateway for enforcement…")
    enforced_at = None
    for _ in range(60):
        r = gw.call("butler-agent", "Supplies___checkout", {**args, "idempotency_key": new_id("idem")}, household_id=HH)
        if r.status == "denied":
            enforced_at = time.monotonic() - t0
            break
        time.sleep(1)
    print(f"enforced {'after %.1fs' % enforced_at if enforced_at else 'NOT within 60s'} (create→ACTIVE {t_active:.1f}s)")
    svc.disable(created)
    print("temporary policy removed")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--propagation", action="store_true")
    ap.add_argument("--propagation-only", action="store_true")
    a = ap.parse_args()
    region = os.environ.get("AWS_REGION", "us-east-1")
    v = ssm_values(a.stage, region)
    scope = v.get("cognito/scope")
    tokens = {
        "butler-agent": CognitoClientCredentials(v["cognito/token-url"], v["cognito/agent-client-id"],
                                                 secret(f"butler/{a.stage}/agent-client", region), scope),
        "approval-executor": CognitoClientCredentials(v["cognito/token-url"], v["cognito/executor-client-id"],
                                                      secret(f"butler/{a.stage}/executor-client", region), scope),
    }
    gw = HttpGatewayClient(v["gateway/url"], tokens, household_id=HH)
    store = Store(v["table-name"], region)
    if not a.propagation_only:
        results = run_cases(gw, store, tokens, v["gateway/url"])
        print(json.dumps(results, indent=2))
        ok = all(r["gateway"] == r["expected"] and r["matcher_agrees"] for r in results)
        print("\nALL CASES MATCH" if ok else "\nMISMATCHES FOUND")
    if a.propagation or a.propagation_only:
        propagation(store, v, gw, region)


if __name__ == "__main__":
    main()
