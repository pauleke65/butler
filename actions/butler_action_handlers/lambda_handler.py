"""AWS Lambda entry point for the AgentCore Gateway action targets (contracts section 7).

One function serves all five targets (Messages, Calendar, Supplies, Services, Context). The Gateway puts the tool name
in ``context.client_context.custom["bedrockAgentCoreToolName"]`` (``<Target>___<tool>``) and the tool arguments in
``event``. The household is never taken from the input: it comes from the ``HOUSEHOLD_ID`` environment variable
(one demo household, D17).

Deliberately light on imports: nothing here pulls in ``butler_rules`` / ``cedarpy`` (a test enforces that), so the
deployment package stays small.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from butler_actions.store import Store

from .adapters import Adapters
from .dispatch import TOOLS, dispatch

log = logging.getLogger("butler.actions.lambda")
if not logging.getLogger().handlers:  # Lambda pre-installs a handler; keep local runs readable too
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

TOOL_NAME_KEY = "bedrockAgentCoreToolName"
DELIMITER = "___"

_store: Store | None = None
_adapters: Adapters | None = None


def _err(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


def raw_tool_name(context: Any) -> str | None:
    """``context.client_context.custom["bedrockAgentCoreToolName"]`` or None when absent."""
    custom = getattr(getattr(context, "client_context", None), "custom", None)
    value = custom.get(TOOL_NAME_KEY) if isinstance(custom, dict) else None
    return value if isinstance(value, str) and value else None


def resolve_tool(raw: str) -> str | None:
    """Map the Gateway's tool name onto a ``dispatch`` key (``Supplies___checkout``).

    The name is ``<Target>___<tool>``; split on the delimiter, tolerate a leading prefix, and accept a bare tool
    name when it is unambiguous.
    """
    if raw in TOOLS:
        return raw
    parts = raw.split(DELIMITER)
    if len(parts) >= 2:
        candidate = DELIMITER.join(parts[-2:])
        if candidate in TOOLS:
            return candidate
    matches = [key for key in TOOLS if key.endswith(DELIMITER + parts[-1])]
    return matches[0] if len(matches) == 1 else None


class _LazyPayments:
    """Builds the real payment adapter on first use, so read-only tools work before the payment key is set."""

    def __init__(self) -> None:
        self._inner: Any = None

    def _adapter(self) -> Any:
        if self._inner is None:
            from .real_adapters import payment_adapter_from_env

            _load_payment_key()
            self._inner = payment_adapter_from_env()
        return self._inner

    def charge(self, *args: Any, **kwargs: Any) -> str:
        return self._adapter().charge(*args, **kwargs)

    def refund(self, *args: Any, **kwargs: Any) -> str:
        return self._adapter().refund(*args, **kwargs)


def _load_payment_key() -> None:
    """Copy the payment test key from Secrets Manager (``PAYMENT_SECRET_ARN``) into the env var the adapter reads."""
    var = "PAYSTACK_SECRET_KEY" if os.environ.get("PAYMENT_PROVIDER", "stripe") == "paystack" else "STRIPE_SECRET_KEY"
    arn = os.environ.get("PAYMENT_SECRET_ARN")
    if os.environ.get(var) or not arn:
        return
    import boto3

    client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    os.environ[var] = client.get_secret_value(SecretId=arn)["SecretString"].strip()


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store()
    return _store


def get_adapters() -> Adapters | None:
    """None = let ``dispatch`` use its env-driven default (``ADAPTERS=fake``); ``real`` is built here (lazy payments)."""
    global _adapters
    if os.environ.get("ADAPTERS", "fake") != "real":
        return None
    if _adapters is None:
        from .real_adapters import (
            GoogleCalendarAdapter,
            OpenMeteoWeatherAdapter,
            SesEmailAdapter,
            load_google_credentials,
        )

        _adapters = Adapters(email=SesEmailAdapter(), calendar=GoogleCalendarAdapter(load_google_credentials),
                             payments=_LazyPayments(), weather=OpenMeteoWeatherAdapter())
    return _adapters


def handler(event: dict[str, Any], context: Any = None, *, store: Store | None = None,
            adapters: Adapters | None = None) -> dict[str, Any]:
    """Gateway Lambda target: ``{ok: true, data}`` or ``{ok: false, error: {code, message}}`` (never raises)."""
    raw = raw_tool_name(context)
    if raw is None:
        return _err("INVALID_INPUT", f"Missing {TOOL_NAME_KEY} in the Lambda client context.")
    tool = resolve_tool(raw)
    if tool is None:
        return _err("NOT_FOUND", f"Unknown tool: {raw}")
    try:
        return dispatch(tool, event if isinstance(event, dict) else {}, store=store or get_store(),
                        adapters=adapters or get_adapters(), household_id=os.environ.get("HOUSEHOLD_ID", "hh_demo"))
    except Exception:
        log.exception("action %s failed", tool)
        return _err("UPSTREAM_UNAVAILABLE", "That service isn't available right now.")
