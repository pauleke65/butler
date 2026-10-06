"""Gateway client and response classification (05-local-build §3, §5)."""
from __future__ import annotations

import inspect
import itertools
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx
from butler_rules import PrincipalName

log = logging.getLogger("butler.gateway")

DENIAL_CODES = {-32001, -32002, -32003}
DENIAL_MARKERS = ("denied", "not authorized", "accessdenied", "policy")
TRANSPORT_ERROR_CODES = {"UPSTREAM_UNAVAILABLE", "UNAUTHORIZED", "GATEWAY_UNREACHABLE", "BAD_GATEWAY_RESPONSE"}


@dataclass
class GatewayResponse:
    status: Literal["ok", "denied", "error"]
    data: dict[str, Any] | None = None  # tool result payload when ok
    error: dict[str, Any] | None = None  # {"code","message"} when error/denied
    request_id: str | None = None


class GatewayClient(Protocol):
    def call(self, principal: PrincipalName, tool: str, args: dict[str, Any]) -> GatewayResponse: ...


# ── classification ────────────────────────────────────────────────────────
def _has_marker(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in DENIAL_MARKERS)


def _text_of(result: dict[str, Any]) -> str:
    return " ".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))


def _request_id(body: dict[str, Any]) -> str | None:
    for holder in (body.get("result"), body.get("error")):
        if isinstance(holder, dict):
            meta = holder.get("_meta") or holder.get("data") or {}
            rid = meta.get("request_id") if isinstance(meta, dict) else None
            if rid:
                return str(rid)
    return None


def _denied(message: str, rid: str | None) -> GatewayResponse:
    return GatewayResponse("denied", None, {"code": "POLICY_DENIED", "message": message or "denied by policy"}, rid)


def _payload(result: dict[str, Any]) -> dict[str, Any] | None:
    """The tool's own payload: structuredContent, else JSON in the first text block."""
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    try:
        parsed = json.loads(_text_of(result))
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _from_result(result: dict[str, Any], rid: str | None) -> GatewayResponse:
    payload = _payload(result)
    is_error = bool(result.get("isError"))
    if payload is not None and "ok" in payload:  # a handler response: never a policy denial
        if payload["ok"] and not is_error:
            return GatewayResponse("ok", payload.get("data") or {}, None, rid)
        err = payload.get("error") or {}
        return GatewayResponse("error", None, {"code": err.get("code", "INTERNAL"),
                                               "message": err.get("message", _text_of(result))}, rid)
    text = _text_of(result)
    if is_error:
        if _has_marker(text):
            return _denied(text, rid)
        return GatewayResponse("error", None, {"code": "INTERNAL", "message": text or "tool error"}, rid)
    return GatewayResponse("ok", payload if payload is not None else {"text": text}, None, rid)


def classify_gateway_response(http_status: int, body: dict[str, Any] | None) -> GatewayResponse:
    """Map an HTTP status + JSON-RPC body onto ok / denied / error (tolerant of the three denial shapes)."""
    body = body if isinstance(body, dict) else {}
    rid = _request_id(body)
    if http_status == 403:
        err = body.get("error")
        msg = err.get("message") if isinstance(err, dict) else body.get("message")
        return _denied(str(msg or "HTTP 403"), rid)
    if http_status == 401:
        return GatewayResponse("error", None, {"code": "UNAUTHORIZED", "message": "gateway rejected the token"}, rid)
    if http_status >= 400:
        return GatewayResponse("error", None, {"code": "UPSTREAM_UNAVAILABLE", "message": f"gateway HTTP {http_status}"}, rid)
    err = body.get("error")
    if isinstance(err, dict):
        message = str(err.get("message", ""))
        if err.get("code") in DENIAL_CODES or _has_marker(message):
            return _denied(message, rid)
        return GatewayResponse("error", None, {"code": "INTERNAL", "message": message or "gateway error"}, rid)
    result = body.get("result")
    if isinstance(result, dict):
        return _from_result(result, rid)
    return GatewayResponse("error", None, {"code": "BAD_GATEWAY_RESPONSE", "message": "no result in gateway response"}, rid)


# ── HTTP client ───────────────────────────────────────────────────────────
class HttpGatewayClient:
    """JSON-RPC ``tools/call`` over HTTP with a bearer token per principal."""

    def __init__(self, url: str, tokens: dict[PrincipalName, Callable[[], str]], *, timeout: float = 20.0,
                 household_id: str | None = None, client: httpx.Client | None = None):
        self.url, self.tokens, self.timeout = url, tokens, timeout
        self.household_id = household_id or os.environ.get("HOUSEHOLD_ID", "hh_demo")
        self._http = client or httpx.Client(timeout=timeout)
        self._ids = itertools.count(1)

    @classmethod
    def from_env(cls, **kw: Any) -> HttpGatewayClient:
        """Local defaults: GATEWAY_URL and the static local tokens (overridable via env)."""
        url = os.environ.get("GATEWAY_URL", "http://localhost:8090/mcp")
        tokens: dict[PrincipalName, Callable[[], str]] = {
            "butler-agent": lambda: os.environ.get("AGENT_TOKEN", "local-agent-token"),
            "approval-executor": lambda: os.environ.get("EXECUTOR_TOKEN", "local-executor-token"),
        }
        return cls(url, tokens, **kw)

    def call(self, principal: PrincipalName, tool: str, args: dict[str, Any], *,
             household_id: str | None = None) -> GatewayResponse:
        payload = {"jsonrpc": "2.0", "id": next(self._ids), "method": "tools/call",
                   "params": {"name": tool, "arguments": args}}
        headers = {"Authorization": f"Bearer {self.tokens[principal]()}", "Content-Type": "application/json",
                   "X-Butler-Household": household_id or self.household_id}
        started = time.monotonic()
        try:
            res = self._http.post(self.url, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            log.warning("gateway unreachable: %s", exc)
            return GatewayResponse("error", None, {"code": "UPSTREAM_UNAVAILABLE", "message": str(exc)})
        try:
            body = res.json()
        except ValueError:
            body = {}
        out = classify_gateway_response(res.status_code, body)
        out.request_id = out.request_id or res.headers.get("x-amzn-requestid") or res.headers.get("x-request-id")
        log.info("gateway %s %s -> %s in %.0fms", principal, tool, out.status, (time.monotonic() - started) * 1000)
        return out


def supports_household(gateway: GatewayClient) -> bool:
    """Whether ``gateway.call`` accepts the optional ``household_id`` keyword."""
    try:
        params = inspect.signature(gateway.call).parameters
    except (TypeError, ValueError):
        return False
    return "household_id" in params or any(p.kind is p.VAR_KEYWORD for p in params.values())


class CognitoClientCredentials:
    """Cached OAuth client-credentials token (AWS: executor/agent -> Gateway). Never exercised offline."""

    def __init__(self, token_url: str, client_id: str, client_secret: str, scope: str | None = None,
                 client: httpx.Client | None = None, clock: Callable[[], float] = time.time):
        self.token_url, self.client_id, self.client_secret, self.scope = token_url, client_id, client_secret, scope
        self._http, self._clock = client or httpx.Client(timeout=10.0), clock
        self._token: str | None = None
        self._expires = 0.0

    def __call__(self) -> str:
        if self._token and self._clock() < self._expires - 30:
            return self._token
        data = {"grant_type": "client_credentials", "client_id": self.client_id, "client_secret": self.client_secret}
        if self.scope:
            data["scope"] = self.scope
        res = self._http.post(self.token_url, data=data)
        res.raise_for_status()
        body = res.json()
        self._token = body["access_token"]
        self._expires = self._clock() + float(body.get("expires_in", 300))
        return self._token
