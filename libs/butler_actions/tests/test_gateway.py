import httpx
import pytest
from butler_actions.gateway import HttpGatewayClient, classify_gateway_response, supports_household


def _tool_result(payload, *, is_error=False, structured=True):
    import json

    res = {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": is_error}
    if structured:
        res["structuredContent"] = payload
    return {"jsonrpc": "2.0", "id": 1, "result": res}


def _text_error(text):
    return {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": text}], "isError": True}}


# ── the three denial shapes (05-local-build §5) ───────────────────────────
def test_denial_http_403_any_body():
    for body in ({}, {"message": "nope"}, {"error": {"message": "AccessDeniedException"}}, None):
        r = classify_gateway_response(403, body)
        assert r.status == "denied" and r.error["code"] == "POLICY_DENIED"


@pytest.mark.parametrize("code", [-32001, -32002, -32003])
def test_denial_jsonrpc_error_codes(code):
    r = classify_gateway_response(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": code, "message": "whatever"}})
    assert r.status == "denied"


@pytest.mark.parametrize("msg", ["Request denied", "caller is not authorized", "AccessDeniedException: x", "Blocked by Policy"])
def test_denial_jsonrpc_error_markers(msg):
    r = classify_gateway_response(200, {"error": {"code": -32000, "message": msg}})
    assert r.status == "denied" and msg in r.error["message"]


@pytest.mark.parametrize("text", ["Tool call denied by policy", "not authorized to perform", "AccessDenied", "Policy evaluation failed"])
def test_denial_tool_error_text(text):
    r = classify_gateway_response(200, _text_error(text))
    assert r.status == "denied"


def test_other_jsonrpc_errors_are_errors_not_denials():
    r = classify_gateway_response(200, {"error": {"code": -32602, "message": "Invalid params"}})
    assert r.status == "error" and r.error["code"] == "INTERNAL"


def test_iserror_without_markers_is_failed_not_denied():
    r = classify_gateway_response(200, _text_error("Lambda timed out"))
    assert r.status == "error" and "timed out" in r.error["message"]


def test_handler_error_is_never_a_denial_even_with_marker_words():
    body = _tool_result({"ok": False, "error": {"code": "INVALID_INPUT", "message": "policy field amount_minor mismatch"}},
                        is_error=True)
    r = classify_gateway_response(200, body)
    assert r.status == "error" and r.error["code"] == "INVALID_INPUT"


def test_ok_structured_and_text_only_payloads():
    r = classify_gateway_response(200, _tool_result({"ok": True, "data": {"order_id": "ord_1"}}))
    assert (r.status, r.data) == ("ok", {"order_id": "ord_1"})
    r = classify_gateway_response(200, _tool_result({"ok": True, "data": {"a": 1}}, structured=False))
    assert (r.status, r.data) == ("ok", {"a": 1})
    r = classify_gateway_response(200, {"result": {"content": [{"type": "text", "text": "plain"}], "isError": False}})
    assert r.status == "ok" and r.data == {"text": "plain"}


def test_http_failures_and_junk():
    assert classify_gateway_response(401, {}).error["code"] == "UNAUTHORIZED"
    assert classify_gateway_response(502, {}).error["code"] == "UPSTREAM_UNAVAILABLE"
    assert classify_gateway_response(200, {}).error["code"] == "BAD_GATEWAY_RESPONSE"
    assert classify_gateway_response(200, None).status == "error"


def test_request_id_extracted():
    body = _tool_result({"ok": True, "data": {}})
    body["result"]["_meta"] = {"request_id": "req-9"}
    assert classify_gateway_response(200, body).request_id == "req-9"


# ── HttpGatewayClient ─────────────────────────────────────────────────────
def _client(handler):
    transport = httpx.MockTransport(handler)
    return HttpGatewayClient("http://gw/mcp", {"butler-agent": lambda: "tok-a", "approval-executor": lambda: "tok-e"},
                             client=httpx.Client(transport=transport), household_id="hh_x")


def test_http_client_sends_jsonrpc_with_bearer_and_household():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen["auth"] = request.headers["authorization"]
        seen["hh"] = request.headers["x-butler-household"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_tool_result({"ok": True, "data": {"x": 1}}), headers={"x-amzn-requestid": "rid-1"})

    c = _client(handler)
    r = c.call("approval-executor", "Supplies___checkout", {"amount_minor": 1})
    assert seen["auth"] == "Bearer tok-e" and seen["hh"] == "hh_x"
    assert seen["body"]["method"] == "tools/call"
    assert seen["body"]["params"] == {"name": "Supplies___checkout", "arguments": {"amount_minor": 1}}
    assert r.status == "ok" and r.data == {"x": 1} and r.request_id == "rid-1"
    c.call("butler-agent", "t", {}, household_id="hh_other")
    assert seen["hh"] == "hh_other"
    assert supports_household(c)


def test_http_client_maps_403_and_network_errors():
    assert _client(lambda req: httpx.Response(403, json={})).call("butler-agent", "t", {}).status == "denied"

    def boom(req):
        raise httpx.ConnectError("refused")

    r = _client(boom).call("butler-agent", "t", {})
    assert r.status == "error" and r.error["code"] == "UPSTREAM_UNAVAILABLE"
    assert _client(lambda req: httpx.Response(200, text="not json")).call("butler-agent", "t", {}).status == "error"


def test_supports_household_false_for_plain_protocol_impls():
    class Plain:
        def call(self, principal, tool, args): ...

    assert not supports_household(Plain())
