"""Framework-free route logic, shared by the Starlette app and the Lambda Function URL handler."""
from __future__ import annotations

import hmac
import json
import os
from datetime import datetime
from typing import Any

from butler_actions.store import Store
from butler_contracts.models import PolicyEvent, Receipt

DEFAULT_LIMIT = 50
MAX_LIMIT = 200
Response = tuple[int, dict[str, Any]]


def token() -> str:
    return os.environ.get("DEBUG_API_TOKEN", "local-debug-token")


def household_id() -> str:
    return os.environ.get("DEBUG_HOUSEHOLD_ID", "hh_demo")


def authorized(authorization: str | None) -> bool:
    """Static bearer token, constant-time compare."""
    if not authorization or not authorization.startswith("Bearer "):
        return False
    return hmac.compare_digest(authorization[7:].strip().encode(), token().encode())


def _limit(raw: str | None) -> int:
    try:
        return max(1, min(int(raw), MAX_LIMIT)) if raw else DEFAULT_LIMIT
    except ValueError:
        return DEFAULT_LIMIT


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=True)


def policy_event(r: Receipt) -> PolicyEvent:
    """One policy decision, derived from a receipt (the Gateway decision is what receipts record)."""
    amount = r.action.args.get("amount_minor")
    return PolicyEvent(
        at=r.authority.evaluated_at, action_id=r.action_id, principal=r.authority.principal, tool=r.action.tool,
        decision=r.authority.decision, rule_ids=r.authority.rule_ids, rule_texts=r.authority.rule_texts,
        amount_minor=amount if type(amount) is int else None, gateway_request_id=r.authority.gateway_request_id)


def _parse_ts(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def get_receipts(store: Store, query: dict[str, str]) -> Response:
    receipts = store.list_receipts_since(household_id(), query.get("since") or None, _limit(query.get("limit")))
    return 200, {"receipts": [_dump(r) for r in receipts]}


def get_rules(store: Store, _: dict[str, str]) -> Response:
    rules = sorted(store.list_rules(household_id()), key=lambda r: (r.created_at, r.rule_id))
    return 200, {"rules": [_dump(r) for r in rules]}


def get_policy_events(store: Store, query: dict[str, str]) -> Response:
    since = _parse_ts(query["since"]) if query.get("since") else None
    if query.get("since") and since is None:
        return 400, {"error": "since must be an ISO timestamp"}
    events = []
    for r in reversed(store.list_receipts(household_id())):  # oldest first
        ev = policy_event(r)
        at = _parse_ts(ev.at)
        if since is None or (at is not None and at > since):
            events.append(_dump(ev))
    return 200, {"events": events[-_limit(query.get("limit")):]}


ROUTES = {"/receipts": get_receipts, "/rules": get_rules, "/policy-events": get_policy_events}


def route(store: Store, method: str, path: str, query: dict[str, str], authorization: str | None) -> Response:
    """(status, JSON body) for a request. ``/health`` needs no token; everything else does."""
    if path == "/health":
        return 200, {"ok": True, "service": "butler-debug-api"}
    if method != "GET" or path not in ROUTES:
        return 404, {"error": "not found"}
    if not authorized(authorization):
        return 401, {"error": "unauthorized"}
    return ROUTES[path](store, query)


def lambda_handler(event: dict[str, Any], context: Any = None, *, store: Store | None = None) -> dict[str, Any]:
    """AWS Lambda Function URL (payload v2) adapter."""
    http = event.get("requestContext", {}).get("http", {})
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    cors = {"access-control-allow-origin": headers.get("origin", "*"), "access-control-allow-headers": "authorization",
            "content-type": "application/json"}
    if http.get("method") == "OPTIONS":
        return {"statusCode": 204, "headers": cors, "body": ""}
    status, body = route(store or Store(), http.get("method", "GET"), event.get("rawPath", "/"),
                         event.get("queryStringParameters") or {}, headers.get("authorization"))
    return {"statusCode": status, "headers": cors, "body": json.dumps(body)}
