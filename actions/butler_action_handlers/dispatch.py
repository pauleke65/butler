"""``dispatch``: validate -> idempotency -> handler -> ``{"ok": ...}`` envelope (contracts §7)."""
from __future__ import annotations

import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from butler_actions import clock
from butler_actions.store import Store
from butler_contracts import models as m
from pydantic import BaseModel, ValidationError

from . import h_calendar, h_context, h_messages, h_services, h_supplies
from .adapters import Adapters, shared_adapters
from .context import Ctx
from .errors import ActionError
from .timeutil import DEFAULT_TZ

log = logging.getLogger("butler.actions")


@dataclass(frozen=True)
class ToolSpec:
    model: type[BaseModel]
    handler: Callable[[Ctx, Any], dict]
    side_effect: bool


TOOLS: dict[str, ToolSpec] = {
    "Messages___send_email": ToolSpec(m.SendEmailInput, h_messages.send_email, True),
    "Calendar___list_events": ToolSpec(m.ListEventsInput, h_calendar.list_events, False),
    "Calendar___create_event": ToolSpec(m.CreateEventInput, h_calendar.create_event, True),
    "Calendar___update_event": ToolSpec(m.UpdateEventInput, h_calendar.update_event, True),
    "Calendar___delete_event": ToolSpec(m.DeleteEventInput, h_calendar.delete_event, True),
    "Supplies___search_products": ToolSpec(m.SearchProductsInput, h_supplies.search_products, False),
    "Supplies___checkout": ToolSpec(m.CheckoutInput, h_supplies.checkout, True),
    "Supplies___refund": ToolSpec(m.RefundInput, h_supplies.refund, True),
    "Services___search_providers": ToolSpec(m.SearchProvidersInput, h_services.search_providers, False),
    "Services___book_service": ToolSpec(m.BookServiceInput, h_services.book_service, True),
    "Services___cancel_booking": ToolSpec(m.CancelBookingInput, h_services.cancel_booking, True),
    "Context___get_weather": ToolSpec(m.GetWeatherInput, h_context.get_weather, False),
}
NON_INPUT_FIELDS = ("reasoning", "household_id")


def _err(code: str, message: str) -> dict:
    return {"ok": False, "error": {"code": code, "message": message}}


def _resolve_household(event: dict[str, Any], household_id: str | None) -> str:
    """Never trust tool input for the household outside local dev (contracts §1)."""
    if household_id:
        return household_id
    if os.environ.get("STAGE", "local") == "local" and event.get("household_id"):
        return str(event["household_id"])
    return os.environ.get("HOUSEHOLD_ID", "hh_demo")


def _format_validation(e: ValidationError) -> str:
    parts = [f"{'.'.join(str(p) for p in err['loc']) or 'input'}: {err['msg']}" for err in e.errors()[:5]]
    return "Invalid input. " + "; ".join(parts)


def _household_tz(store: Store, household_id: str) -> str:
    hh = store.get_household(household_id)
    return hh.timezone if hh else DEFAULT_TZ


def dispatch(tool: str, event: dict[str, Any], *, store: Store, now: datetime | None = None,
             adapters: Adapters | None = None, household_id: str | None = None) -> dict:
    spec = TOOLS.get(tool)
    if spec is None:
        return _err("NOT_FOUND", f"Unknown tool: {tool}")
    hh = _resolve_household(event, household_id)
    payload = {k: v for k, v in event.items() if k not in NON_INPUT_FIELDS}
    try:
        inp = spec.model.model_validate(payload)
    except ValidationError as e:
        return _err("INVALID_INPUT", _format_validation(e))
    key = payload["idempotency_key"]
    if spec.side_effect and (original := store.get_idempotent(key)) is not None:
        return original
    ctx = Ctx(store, now or clock.now(), adapters or shared_adapters(), hh, _household_tz(store, hh))
    try:
        result = {"ok": True, "data": spec.handler(ctx, inp)}
    except ActionError as e:
        return _err(e.code, e.message)
    except Exception:
        log.exception("handler %s crashed", tool)
        return _err("INTERNAL", "Something went wrong running that action.")
    if spec.side_effect and not store.put_idempotent(key, result):
        return store.get_idempotent(key) or result
    return result
