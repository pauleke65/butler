"""Services___*: simulated providers with deterministic weekly slots."""
from __future__ import annotations

import hashlib
from typing import Any

from butler_actions.ids import new_id
from butler_contracts.models import BookServiceInput, CancelBookingInput, SearchProvidersInput

from . import seeddata
from .context import Ctx
from .errors import InvalidInput, NotFound
from .timeutil import next_slot, parse_instant, to_local

_PARTS = {"morning": (5, 12), "afternoon": (12, 17), "evening": (17, 22)}


def _slot(provider: dict[str, Any], ctx: Ctx) -> str:
    s = provider["slot"]
    return next_slot(s["weekday"], s["hour"], ctx.now, ctx.tz).isoformat(timespec="minutes")


def _in_window(hour: int, window: str | None) -> bool:
    if not window:
        return True
    lo, hi = _PARTS.get(window.lower(), (0, 24))
    return lo <= hour < hi


def search_providers(ctx: Ctx, inp: SearchProvidersInput) -> dict:
    wanted_by = parse_instant(inp.date, ctx.tz, end_of_day=True)
    found = []
    for p in seeddata.providers():
        if p["service_type"] != inp.service_type:
            continue
        slot = _slot(p, ctx)
        if parse_instant(slot, ctx.tz) > wanted_by or not _in_window(to_local(parse_instant(slot, ctx.tz), ctx.tz).hour, inp.window):
            continue
        found.append({"provider_id": p["provider_id"], "name": p["name"], "rating": p["rating"],
                      "price_minor": p["price_minor"], "currency": "USD", "slot_start": slot, "simulated": True})
    found.sort(key=lambda f: (-f["rating"], f["price_minor"]))
    return {"providers": found[:5]}


def book_service(ctx: Ctx, inp: BookServiceInput) -> dict:
    provider = seeddata.providers_by_id().get(inp.provider_id)
    if provider is None:
        raise InvalidInput(f"Unknown provider: {inp.provider_id}")
    if provider["service_type"] != inp.service_type:
        raise InvalidInput(f"{provider['name']} does not offer {inp.service_type}.")
    if inp.amount_minor != provider["price_minor"]:
        raise InvalidInput(f"amount_minor {inp.amount_minor} does not match the provider price {provider['price_minor']}.")
    slot = to_local(parse_instant(inp.slot_start, ctx.tz), ctx.tz)
    if (slot.weekday(), slot.hour, slot.minute) != (provider["slot"]["weekday"], provider["slot"]["hour"], 0):
        raise InvalidInput(f"{provider['name']} is not available at {inp.slot_start}.")
    booking_id = new_id("bkg")
    code = "BK-" + hashlib.sha1(booking_id.encode()).hexdigest()[:6].upper()
    ctx.store.put_record(ctx.household_id, "booking", booking_id, {
        "booking_id": booking_id, "provider_id": inp.provider_id, "provider_name": provider["name"],
        "service_type": inp.service_type, "slot_start": inp.slot_start, "amount_minor": inp.amount_minor,
        "confirmation_code": code, "status": "booked", "simulated": True, "plan_id": inp.plan_id,
        "created_at": ctx.now.isoformat(timespec="seconds")})
    return {"booking_id": booking_id, "confirmation_code": code, "simulated": True}


def cancel_booking(ctx: Ctx, inp: CancelBookingInput) -> dict:
    booking = ctx.store.get_record(ctx.household_id, "booking", inp.booking_id)
    if booking is None:
        raise NotFound(f"Booking {inp.booking_id} not found.")
    booking["status"] = "cancelled"
    ctx.store.put_record(ctx.household_id, "booking", inp.booking_id, booking)
    return {"cancelled": True}
