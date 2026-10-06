import json

import pytest
from butler_actions.testing import CedarFakeGateway
from butler_actions.wrapper import call_action
from butler_contracts.models import PolicyEvent, Receipt, Rule
from debug_api.app import create_app
from debug_api.core import lambda_handler
from starlette.testclient import TestClient

AUTH = {"Authorization": "Bearer local-debug-token"}


def checkout(store, gw, amount, principal="butler-agent"):
    args = {"merchant": "m", "items": [{"sku": "s", "qty": 1}], "amount_minor": amount, "currency": "USD", "category": "drinks"}
    return call_action(principal, "Supplies___checkout", args, household_id="hh_demo", correlation_id="c", store=store,
                       gateway=gw, rules=store.list_rules("hh_demo", active_only=True))


@pytest.fixture
def api(store, pinned_now):
    from butler_rules import Identities, LocalPolicyService, default_rules

    ids = Identities.local()
    svc = LocalPolicyService(store, ids=ids)
    for r in default_rules("hh_demo", ids, "2026-10-06T12:00:00+00:00"):
        svc.create(r)
    gw = CedarFakeGateway(store)
    outcomes = [checkout(store, gw, 4200), checkout(store, gw, 5200), checkout(store, gw, 5200, "approval-executor")]
    return TestClient(create_app(store)), store, outcomes


def test_health_needs_no_token(api):
    client, *_ = api
    assert client.get("/health").json() == {"ok": True, "service": "butler-debug-api"}


@pytest.mark.parametrize("path", ["/receipts", "/rules", "/policy-events"])
def test_auth_required(api, path):
    client, *_ = api
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get(path, headers={"Authorization": "Basic x"}).status_code == 401
    assert client.get(path, headers=AUTH).status_code == 200


def test_receipts_newest_last_and_valid_models(api):
    client, _, outcomes = api
    body = client.get("/receipts", headers=AUTH).json()
    got = [Receipt(**r) for r in body["receipts"]]
    assert [r.action_id for r in got] == [o.receipt.action_id for o in outcomes]
    assert [r.status for r in got] == ["executed", "held_for_approval", "executed"]


def test_receipts_since_and_limit(api):
    client, store, outcomes = api
    ids = [o.receipt.action_id for o in outcomes]
    body = client.get("/receipts", params={"since": ids[0]}, headers=AUTH).json()
    assert [r["action_id"] for r in body["receipts"]] == ids[1:]
    assert client.get("/receipts", params={"since": ids[2]}, headers=AUTH).json() == {"receipts": []}
    assert [r["action_id"] for r in client.get("/receipts", params={"limit": 2}, headers=AUTH).json()["receipts"]] == ids[1:]
    assert [r["action_id"] for r in client.get("/receipts", params={"since": ids[0], "limit": 1}, headers=AUTH).json()["receipts"]] == ids[1:2]
    assert len(client.get("/receipts", params={"limit": "junk"}, headers=AUTH).json()["receipts"]) == 3
    # a receipt written after the first poll shows up on the next poll
    late = checkout(store, CedarFakeGateway(store), 100)
    assert [r["action_id"] for r in client.get("/receipts", params={"since": ids[2]}, headers=AUTH).json()["receipts"]] == [late.receipt.action_id]


def test_rules_include_drafts_and_policy_status(api):
    client, store, _ = api
    from butler_contracts.models import RuleDraft
    from butler_rules import Identities, draft_to_rule

    draft = draft_to_rule(RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                                    effect="ask_first", confidence=0.9), "hh_demo", origin={"type": "default"},
                          now="2026-10-06T13:00:00+00:00", ids=Identities.local())
    store.put_rule(draft)
    rules = [Rule(**r) for r in client.get("/rules", headers=AUTH).json()["rules"]]
    assert len(rules) == 6 and rules[-1].policy_status == "draft" and not rules[-1].active
    assert {r.rule_id for r in rules if r.active} == {f"rule_default_{x}" for x in ("spend", "contacts", "calendar", "services", "refunds")}


def test_policy_events_derived_from_receipts(api):
    client, _, outcomes = api
    events = [PolicyEvent(**e) for e in client.get("/policy-events", headers=AUTH).json()["events"]]
    assert [(e.principal, e.decision, e.tool, e.amount_minor) for e in events] == [
        ("butler-agent", "ALLOW", "Supplies___checkout", 4200),
        ("butler-agent", "DENY", "Supplies___checkout", 5200),
        ("approval-executor", "ALLOW", "Supplies___checkout", 5200),
    ]
    assert events[1].rule_ids == ["rule_default_spend"] and "50 dollars" in events[1].rule_texts[0]
    assert events[0].gateway_request_id == "req-fake"
    assert [e.action_id for e in events] == [o.receipt.action_id for o in outcomes]


def test_policy_events_since_timestamp(api):
    client, _, _ = api
    assert client.get("/policy-events", params={"since": "2026-10-06T12:00:00+00:00"}, headers=AUTH).json() == {"events": []}
    assert len(client.get("/policy-events", params={"since": "2026-10-06T11:59:59Z"}, headers=AUTH).json()["events"]) == 3
    assert client.get("/policy-events", params={"since": "garbage"}, headers=AUTH).status_code == 400


def test_cors_allows_localhost_only(api):
    client, *_ = api
    pre = client.options("/receipts", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "GET",
                                               "Access-Control-Request-Headers": "authorization"})
    assert pre.status_code == 200 and pre.headers["access-control-allow-origin"] == "http://localhost:3000"
    ok = client.get("/health", headers={"Origin": "http://127.0.0.1:3001"})
    assert ok.headers["access-control-allow-origin"] == "http://127.0.0.1:3001"
    evil = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in evil.headers


def test_unknown_route_and_method(api):
    client, *_ = api
    assert client.get("/nope", headers=AUTH).status_code == 404
    assert client.post("/rules", headers=AUTH).status_code == 405


def test_token_from_env(api, monkeypatch):
    client, *_ = api
    monkeypatch.setenv("DEBUG_API_TOKEN", "rotated")
    assert client.get("/rules", headers=AUTH).status_code == 401
    assert client.get("/rules", headers={"Authorization": "Bearer rotated"}).status_code == 200


def test_lambda_function_url_adapter(api):
    _, store, outcomes = api
    event = {"rawPath": "/receipts", "queryStringParameters": {"limit": "1"}, "headers": {"Authorization": "Bearer local-debug-token"},
             "requestContext": {"http": {"method": "GET"}}}
    res = lambda_handler(event, store=store)
    assert res["statusCode"] == 200 and json.loads(res["body"])["receipts"][0]["action_id"] == outcomes[-1].receipt.action_id
    event["headers"] = {}
    assert lambda_handler(event, store=store)["statusCode"] == 401
    event["requestContext"] = {"http": {"method": "OPTIONS"}}
    assert lambda_handler(event, store=store)["statusCode"] == 204
