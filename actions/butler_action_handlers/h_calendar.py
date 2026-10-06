"""Calendar___*: events created by Butler are owned by "butler"; update/delete re-check ownership."""
from __future__ import annotations

from typing import Any

from butler_contracts.models import (
    CreateEventInput,
    DeleteEventInput,
    ListEventsInput,
    UpdateEventInput,
)

from .context import Ctx
from .errors import InvalidInput, NotFound
from .timeutil import parse_instant


def _attendee_emails(ctx: Ctx, ids: list[str] | None) -> list[str]:
    emails: list[str] = []
    for cid in dict.fromkeys(ids or []):
        c = ctx.store.get_contact(ctx.household_id, cid)
        if c is None:
            raise InvalidInput(f"Unknown contact id: {cid}")
        emails.append(c.email)
    return emails


def create_event(ctx: Ctx, inp: CreateEventInput) -> dict:
    if parse_instant(inp.end, ctx.tz) <= parse_instant(inp.start, ctx.tz):
        raise InvalidInput("Event end must be after its start.")
    created = ctx.adapters.calendar.create_event(
        title=inp.title, start=inp.start, end=inp.end, attendee_emails=_attendee_emails(ctx, inp.attendee_contact_ids),
        location=inp.location, description=inp.description, owner="butler")
    ctx.store.put_record(ctx.household_id, "event", created["event_id"], {
        "event_id": created["event_id"], "title": inp.title, "start": inp.start, "end": inp.end,
        "butler_owner": "butler", "attendee_contact_ids": inp.attendee_contact_ids or [],
        "html_link": created.get("html_link", ""), "plan_id": inp.plan_id, "deleted": False,
        "created_at": ctx.now.isoformat(timespec="seconds")})
    return {"event_id": created["event_id"], "html_link": created.get("html_link", "")}


def _actual_owner(ctx: Ctx, event_id: str) -> tuple[str, dict[str, Any] | None]:
    """Owner according to our own record first, then the calendar provider."""
    record = ctx.store.get_record(ctx.household_id, "event", event_id)
    if record is not None:
        if record.get("deleted"):
            raise NotFound(f"Event {event_id} was already deleted.")
        return record.get("butler_owner", "human"), record
    remote = ctx.adapters.calendar.get_event(event_id)
    if remote is None:
        raise NotFound(f"Event {event_id} not found.")
    return remote.get("butler_owner", "human"), None


def _check_owner(ctx: Ctx, event_id: str, claimed: str) -> dict[str, Any] | None:
    actual, record = _actual_owner(ctx, event_id)
    if actual != claimed:
        raise InvalidInput(f"event_owner mismatch: event {event_id} is owned by {actual!r}, not {claimed!r}.")
    return record


def update_event(ctx: Ctx, inp: UpdateEventInput) -> dict:
    record = _check_owner(ctx, inp.event_id, inp.event_owner)
    fields = {"title": inp.title, "start": inp.start, "end": inp.end}
    ctx.adapters.calendar.update_event(inp.event_id, fields)
    if record is not None:
        record.update({k: v for k, v in fields.items() if v is not None})
        ctx.store.put_record(ctx.household_id, "event", inp.event_id, record)
    return {"event_id": inp.event_id}


def delete_event(ctx: Ctx, inp: DeleteEventInput) -> dict:
    record = _check_owner(ctx, inp.event_id, inp.event_owner)
    ctx.adapters.calendar.delete_event(inp.event_id)
    if record is not None:
        record["deleted"] = True
        ctx.store.put_record(ctx.household_id, "event", inp.event_id, record)
    return {"deleted": True}


def list_events(ctx: Ctx, inp: ListEventsInput) -> dict:
    lo, hi = parse_instant(inp.from_, ctx.tz), parse_instant(inp.to, ctx.tz, end_of_day=True)
    events = {e["event_id"]: e for e in ctx.adapters.calendar.list_events(inp.from_, inp.to)}
    for r in ctx.store.list_records(ctx.household_id, "event"):
        if r.get("deleted") or r["event_id"] in events:
            continue
        if parse_instant(r["start"], ctx.tz) < hi and lo < parse_instant(r["end"], ctx.tz):
            events[r["event_id"]] = {k: r[k] for k in ("event_id", "title", "start", "end", "butler_owner")}
    return {"events": sorted(events.values(), key=lambda e: e["start"])}
