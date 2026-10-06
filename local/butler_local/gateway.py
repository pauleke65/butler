"""Local Gateway emulator (05-local-build §4): MCP-ish JSON-RPC on :8090 that enforces the real compiled Cedar."""
from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from types import ModuleType
from typing import Any

import uvicorn
from butler_actions.store import Store
from butler_contracts import models as m
from butler_contracts.models import Rule
from butler_rules import CedarEvaluator, Identities, PrincipalName, policy_field_problems
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

log = logging.getLogger("butler.local_gateway")

TOOL_MODELS: dict[str, Any] = {
    "Messages___send_email": m.SendEmailInput, "Calendar___list_events": m.ListEventsInput,
    "Calendar___create_event": m.CreateEventInput, "Calendar___update_event": m.UpdateEventInput,
    "Calendar___delete_event": m.DeleteEventInput, "Supplies___search_products": m.SearchProductsInput,
    "Supplies___checkout": m.CheckoutInput, "Supplies___refund": m.RefundInput,
    "Services___search_providers": m.SearchProvidersInput, "Services___book_service": m.BookServiceInput,
    "Services___cancel_booking": m.CancelBookingInput, "Context___get_weather": m.GetWeatherInput,
}
DENY_STYLES = ("jsonrpc_error", "tool_error", "http_403")
Dispatch = Callable[..., dict[str, Any]]


def default_tokens() -> dict[str, PrincipalName]:
    return {os.environ.get("AGENT_TOKEN", "local-agent-token"): "butler-agent",
            os.environ.get("EXECUTOR_TOKEN", "local-executor-token"): "approval-executor"}


def _stub_dispatch(tool: str, event: dict[str, Any], **_: Any) -> dict[str, Any]:
    log.warning("butler_action_handlers.dispatch not available yet: STUB result for %s", tool)
    return {"ok": True, "data": {"stub": True}}


def resolve_dispatch() -> Dispatch:
    """Workstream B's ``butler_action_handlers.dispatch``, imported lazily; a stub until it exists."""
    try:
        from butler_action_handlers import dispatch  # type: ignore[attr-defined]
    except (ImportError, AttributeError):
        return _stub_dispatch
    if isinstance(dispatch, ModuleType):  # `from pkg import dispatch` can resolve to the submodule
        dispatch = getattr(dispatch, "dispatch", None)
    return dispatch if callable(dispatch) else _stub_dispatch


def effective_rules(rules: list[Rule], delay_ms: int, now: datetime | None = None) -> list[Rule]:
    """Rules as the Gateway would see them: eventual consistency of ``delay_ms`` after create and after disable."""
    now = now or datetime.now(UTC)
    out: list[Rule] = []
    for r in rules:
        age_ms = (now - datetime.fromisoformat(r.updated_at)).total_seconds() * 1000
        settled = age_ms >= delay_ms or age_ms < 0  # a pinned-future clock stamp counts as settled
        if r.active and settled:
            out.append(r)
        elif r.policy_status == "disabled" and not settled:
            out.append(r.model_copy(update={"active": True}))  # the delete has not propagated yet
    return out


class LocalGateway:
    """The emulator's logic, kept apart from the HTTP layer so it is easy to test."""

    def __init__(self, store: Store, ids: Identities | None = None, *, delay_ms: int | None = None,
                 deny_style: str | None = None, dispatch: Dispatch | None = None,
                 tokens: dict[str, PrincipalName] | None = None):
        self.store, self.ids = store, ids or Identities.local()
        self.delay_ms = int(os.environ.get("POLICY_DELAY_MS", "800")) if delay_ms is None else delay_ms
        self.deny_style = deny_style or os.environ.get("DENY_STYLE", "jsonrpc_error")
        if self.deny_style not in DENY_STYLES:
            raise ValueError(f"DENY_STYLE must be one of {DENY_STYLES}")
        self._dispatch = dispatch
        self.tokens = tokens or default_tokens()

    @property
    def dispatch(self) -> Dispatch:
        if self._dispatch is None:
            self._dispatch = resolve_dispatch()
        return self._dispatch

    def tools(self) -> list[dict[str, Any]]:
        return [{"name": name, "description": f"Butler action {name.split('___')[1]} ({name.split('___')[0]})",
                 "inputSchema": model.model_json_schema()} for name, model in TOOL_MODELS.items()]

    def authorize(self, principal: PrincipalName, household_id: str, tool: str, args: dict[str, Any]) -> Any:
        rules = effective_rules(self.store.list_rules(household_id), self.delay_ms)
        return CedarEvaluator(rules, self.ids).evaluate(principal, tool, args)

    def call_tool(self, principal: PrincipalName, household_id: str, tool: str, args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        """("denied", {}) or ("ok", handler result). Policy first, then handler-side validation."""
        res = self.authorize(principal, household_id, tool, args)
        log.info("gateway principal=%s tool=%s decision=%s determining=%s errors=%d", principal, tool, res.decision,
                 res.determining, len(res.errors))
        if res.decision == "DENY":
            return "denied", {}
        if problems := policy_field_problems(args, tool):  # what the Lambda re-validation would reject
            return "ok", {"ok": False, "error": {"code": "INVALID_INPUT", "message": "; ".join(problems)}}
        try:
            return "ok", self.dispatch(tool, args, store=self.store, household_id=household_id)
        except Exception as exc:
            log.exception("handler failed for %s", tool)
            return "ok", {"ok": False, "error": {"code": "INTERNAL", "message": f"handler error: {type(exc).__name__}"}}


def _rpc_result(rid: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _rpc_error(rid: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _denied_response(style: str, rid: Any, request_id: str) -> Response:
    headers = {"x-amzn-requestid": request_id}
    if style == "http_403":
        return JSONResponse({"message": "Forbidden: tool call denied by policy"}, 403, headers)
    if style == "tool_error":
        text = "Tool Execution Denied: the request was denied by policy"
        return JSONResponse(_rpc_result(rid, {"content": [{"type": "text", "text": text}], "isError": True}),
                            headers=headers)
    return JSONResponse(_rpc_error(rid, -32002, "Policy denied: tool call is not authorized"), headers=headers)


def create_app(store: Store | None = None, ids: Identities | None = None, **kw: Any) -> Starlette:
    """Starlette app: ``POST /mcp`` (JSON-RPC) and ``GET /health``. Keyword args go to ``LocalGateway``."""
    gw = LocalGateway(store or Store(), ids, **kw)

    async def mcp(request: Request) -> Response:
        principal = gw.tokens.get(request.headers.get("authorization", "").removeprefix("Bearer ").strip())
        if principal is None:
            return JSONResponse({"message": "Unauthorized"}, 401)
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse(_rpc_error(None, -32700, "Parse error"))
        if not isinstance(body, dict) or "method" not in body:
            return JSONResponse(_rpc_error(None, -32600, "Invalid Request"))
        rid, method, params = body.get("id"), body["method"], body.get("params") or {}
        request_id = uuid.uuid4().hex
        if "id" not in body:  # notification
            return Response(status_code=202)
        if method == "initialize":
            return JSONResponse(_rpc_result(rid, {
                "protocolVersion": params.get("protocolVersion", "2025-03-26"), "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "butler-local-gateway", "version": "0.1.0"}}))
        if method == "ping":
            return JSONResponse(_rpc_result(rid, {}))
        if method == "tools/list":
            return JSONResponse(_rpc_result(rid, {"tools": gw.tools()}))
        if method != "tools/call":
            return JSONResponse(_rpc_error(rid, -32601, f"Method not found: {method}"))
        name, args = params.get("name"), params.get("arguments") or {}
        if name not in TOOL_MODELS or not isinstance(args, dict):
            return JSONResponse(_rpc_error(rid, -32602, f"Unknown tool or bad arguments: {name}"))
        household = request.headers.get("x-butler-household") or os.environ.get("HOUSEHOLD_ID", "hh_demo")
        outcome, res = await run_in_threadpool(gw.call_tool, principal, household, name, args)
        if outcome == "denied":
            return _denied_response(gw.deny_style, rid, request_id)
        result = {"content": [{"type": "text", "text": json.dumps(res, default=str)}], "structuredContent": res,
                  "isError": not res.get("ok", True), "_meta": {"request_id": request_id}}
        return JSONResponse(_rpc_result(rid, result), headers={"x-amzn-requestid": request_id})

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"ok": True, "service": "butler-local-gateway", "deny_style": gw.deny_style,
                             "policy_delay_ms": gw.delay_ms})

    app = Starlette(routes=[Route("/mcp", mcp, methods=["POST"]), Route("/health", health)])
    app.state.gateway = gw
    return app


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    uvicorn.run(create_app(), host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("GATEWAY_PORT", "8090")), log_level="warning")


if __name__ == "__main__":
    main()
