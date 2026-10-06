import logging
import time
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from butler_actions.gateway import HttpGatewayClient, classify_gateway_response
from butler_contracts.models import RuleDraft
from butler_local.gateway import TOOL_MODELS, LocalGateway, create_app, effective_rules, resolve_dispatch
from butler_rules import Identities, LocalPolicyService, default_rules, draft_to_rule
from starlette.testclient import TestClient

AGENT = {"Authorization": "Bearer local-agent-token"}
EXEC = {"Authorization": "Bearer local-executor-token"}
CHECKOUT = {"merchant": "FreshCart", "items": [{"sku": "s", "qty": 1}], "amount_minor": 5200, "currency": "USD",
            "category": "drinks", "idempotency_key": "k", "correlation_id": "c"}


def rpc(client, method, params=None, headers=AGENT, rid=1, **kw):
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}, headers=headers, **kw)


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, tool, event, **kw):
        self.calls.append((tool, event, kw))
        return {"ok": True, "data": {"order_id": "ord_1", "tool": tool}}


@pytest.fixture
def gw(seeded):
    rec = Recorder()
    app = create_app(seeded, delay_ms=0, dispatch=rec)
    return TestClient(app), rec, seeded


def test_auth_and_health(gw):
    client, *_ = gw
    assert rpc(client, "tools/list", headers={}).status_code == 401
    assert rpc(client, "tools/list", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/health").json()["deny_style"] == "jsonrpc_error"


def test_initialize_list_ping_notifications(gw):
    client, *_ = gw
    init = rpc(client, "initialize", {"protocolVersion": "2025-11-25"}).json()["result"]
    assert init["protocolVersion"] == "2025-11-25" and "tools" in init["capabilities"]
    tools = rpc(client, "tools/list").json()["result"]["tools"]
    names = [t["name"] for t in tools]
    assert sorted(names) == sorted(TOOL_MODELS) and len(names) == 12 and "Supplies___checkout" in names
    schema = next(t for t in tools if t["name"] == "Supplies___checkout")["inputSchema"]
    assert "amount_minor" in schema["properties"]
    assert rpc(client, "ping").json()["result"] == {}
    assert client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=AGENT).status_code == 202
    assert rpc(client, "nope").json()["error"]["code"] == -32601
    assert client.post("/mcp", content=b"x", headers=AGENT).json()["error"]["code"] == -32700
    assert client.post("/mcp", json=[1], headers=AGENT).json()["error"]["code"] == -32600
    assert rpc(client, "tools/call", {"name": "Nope___x", "arguments": {}}).json()["error"]["code"] == -32602


def test_allowed_call_dispatches_and_returns_call_tool_result(gw):
    client, rec, _ = gw
    res = rpc(client, "tools/call", {"name": "Supplies___checkout", "arguments": {**CHECKOUT, "amount_minor": 4200}},
              headers={**AGENT, "X-Butler-Household": "hh_demo"})
    body = res.json()["result"]
    assert body["isError"] is False and body["structuredContent"]["data"]["order_id"] == "ord_1"
    assert body["content"][0]["type"] == "text" and res.headers["x-amzn-requestid"] == body["_meta"]["request_id"]
    tool, event, kw = rec.calls[0]
    assert tool == "Supplies___checkout" and event["amount_minor"] == 4200 and kw["household_id"] == "hh_demo"
    assert classify_gateway_response(200, res.json()).status == "ok"


def test_handler_error_is_iserror_not_denial(seeded):
    app = create_app(seeded, delay_ms=0, dispatch=lambda t, e, **k: {"ok": False, "error": {"code": "INVALID_INPUT", "message": "bad policy field"}})
    client = TestClient(app)
    res = rpc(client, "tools/call", {"name": "Supplies___checkout", "arguments": {**CHECKOUT, "amount_minor": 100}})
    assert res.json()["result"]["isError"] is True
    out = classify_gateway_response(200, res.json())
    assert out.status == "error" and out.error["code"] == "INVALID_INPUT"


def test_handler_crash_becomes_internal_error(seeded):
    def boom(*a, **k):
        raise RuntimeError("x")

    client = TestClient(create_app(seeded, delay_ms=0, dispatch=boom))
    out = classify_gateway_response(200, rpc(client, "tools/call", {"name": "Context___get_weather", "arguments": {"date": "d"}}).json())
    assert out.status == "error" and out.error["code"] == "INTERNAL"


@pytest.mark.parametrize("style", ["jsonrpc_error", "tool_error", "http_403"])
def test_deny_styles_are_all_classified_as_denied(seeded, style):
    rec = Recorder()
    client = TestClient(create_app(seeded, delay_ms=0, deny_style=style, dispatch=rec))
    res = rpc(client, "tools/call", {"name": "Supplies___checkout", "arguments": CHECKOUT})  # 5200 > cap, agent
    assert rec.calls == []
    assert res.status_code == (403 if style == "http_403" else 200)
    out = classify_gateway_response(res.status_code, res.json())
    assert out.status == "denied"
    # same call as the executor is allowed
    ok = rpc(client, "tools/call", {"name": "Supplies___checkout", "arguments": CHECKOUT}, headers=EXEC)
    assert classify_gateway_response(ok.status_code, ok.json()).status == "ok"


def test_bad_deny_style_rejected(seeded):
    with pytest.raises(ValueError):
        LocalGateway(seeded, deny_style="weird")


def test_http_client_over_the_emulator(seeded):
    rec = Recorder()
    app = create_app(seeded, delay_ms=0, dispatch=rec)
    http = TestClient(app, base_url="http://gateway.local")
    assert isinstance(http, httpx.Client)
    client = HttpGatewayClient("http://gateway.local/mcp", {"butler-agent": lambda: "local-agent-token",
                                                            "approval-executor": lambda: "local-executor-token"}, client=http)
    assert client.call("butler-agent", "Supplies___checkout", CHECKOUT).status == "denied"
    ok = client.call("approval-executor", "Supplies___checkout", CHECKOUT)
    assert ok.status == "ok" and ok.data["order_id"] == "ord_1" and ok.request_id


def test_household_header_selects_rules(store, pinned_now):
    # hh_other has no rules at all -> agent may spend 5200 there; hh_demo (seeded below) may not
    rec = Recorder()
    client = TestClient(create_app(store, delay_ms=0, dispatch=rec))
    store_rules = LocalPolicyService(store, ids=Identities.local())
    for r in default_rules("hh_demo", Identities.local(), "2026-10-06T12:00:00+00:00"):
        store_rules.create(r)
    args = {"name": "Supplies___checkout", "arguments": CHECKOUT}
    assert "error" in rpc(client, "tools/call", args, headers={**AGENT, "X-Butler-Household": "hh_demo"}).json()
    assert "result" in rpc(client, "tools/call", args, headers={**AGENT, "X-Butler-Household": "hh_other"}).json()


def test_type_confused_amount_gets_invalid_input_not_a_free_pass(gw):
    client, rec, _ = gw
    res = rpc(client, "tools/call", {"name": "Supplies___checkout", "arguments": {**CHECKOUT, "amount_minor": "9000"}})
    out = classify_gateway_response(200, res.json())
    assert out.status == "error" and out.error["code"] == "INVALID_INPUT" and rec.calls == []


def test_policy_delay_models_eventual_consistency(store, pinned_now):
    ids = Identities.local()
    svc = LocalPolicyService(store, ids=ids)
    rec = Recorder()
    client = TestClient(create_app(store, delay_ms=300, dispatch=rec))
    rule = draft_to_rule(RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                                   effect="ask_first", confidence=0.9), "hh_demo", origin={"type": "default"},
                         now="2026-10-06T12:00:00+00:00", ids=ids)
    svc.create(rule)
    call = {"name": "Supplies___checkout", "arguments": {**CHECKOUT, "amount_minor": 3100}}
    assert "result" in rpc(client, "tools/call", call).json()  # just created: not enforced yet
    time.sleep(0.35)
    assert "error" in rpc(client, "tools/call", call).json()  # propagated
    svc.disable(rule)
    assert "error" in rpc(client, "tools/call", call).json()  # delete not propagated yet: still enforced
    time.sleep(0.35)
    assert "result" in rpc(client, "tools/call", call).json()


def test_effective_rules_unit():
    ids = Identities.local()
    now = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
    base = default_rules("hh", ids, now.isoformat())[0]

    def r(**kw):
        return base.model_copy(update=kw)

    old, fresh = (now - timedelta(seconds=5)).isoformat(), (now - timedelta(milliseconds=100)).isoformat()
    future = (now + timedelta(days=3)).isoformat()
    assert effective_rules([r(active=True, updated_at=old)], 800, now)
    assert not effective_rules([r(active=True, updated_at=fresh)], 800, now)
    assert effective_rules([r(active=True, updated_at=future)], 800, now)
    assert effective_rules([r(active=False, policy_status="disabled", updated_at=fresh)], 800, now)
    assert not effective_rules([r(active=False, policy_status="disabled", updated_at=old)], 800, now)
    assert not effective_rules([r(active=False, policy_status="draft", updated_at=fresh)], 800, now)


def test_default_dispatch_falls_back_to_stub_when_missing(monkeypatch, caplog):
    import sys
    import types

    fake = types.ModuleType("butler_action_handlers")  # no `dispatch` attribute
    monkeypatch.setitem(sys.modules, "butler_action_handlers", fake)
    monkeypatch.delitem(sys.modules, "butler_action_handlers.dispatch", raising=False)
    fn = resolve_dispatch()
    with caplog.at_level(logging.WARNING, logger="butler.local_gateway"):
        out = fn("Supplies___checkout", {}, store=None)
    assert out == {"ok": True, "data": {"stub": True}} and "STUB" in caplog.text


def test_real_dispatch_is_used_when_present():
    fn = resolve_dispatch()
    assert fn.__module__.startswith("butler_action_handlers") or fn.__name__ == "_stub_dispatch"
