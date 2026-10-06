"""Adapter protocols, deterministic fakes and the ``default_adapters`` factory (05-local-build §3).

Fakes never touch the network and record everything they "send" so tests and the demo can assert on it.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import time, timedelta
from typing import Any, Literal, Protocol

from .timeutil import DEFAULT_TZ, at, parse_instant


class EmailAdapter(Protocol):
    def send(self, to: str, subject: str, body_text: str, body_html: str | None = None) -> str: ...


class CalendarAdapter(Protocol):
    def create_event(self, *, title: str, start: str, end: str, attendee_emails: list[str],
                     location: str | None, description: str | None, owner: str) -> dict[str, Any]: ...
    def get_event(self, event_id: str) -> dict[str, Any] | None: ...
    def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]: ...
    def delete_event(self, event_id: str) -> None: ...
    def list_events(self, time_min: str, time_max: str) -> list[dict[str, Any]]: ...


class PaymentAdapter(Protocol):
    def charge(self, amount_minor: int, currency: str, description: str, idempotency_key: str,
               metadata: dict[str, str]) -> str: ...
    def refund(self, payment_ref: str, amount_minor: int, idempotency_key: str) -> str: ...


class WeatherAdapter(Protocol):
    def forecast(self, date: str, lat: float, lon: float) -> dict[str, Any]: ...


@dataclass
class Adapters:
    email: EmailAdapter
    calendar: CalendarAdapter
    payments: PaymentAdapter
    weather: WeatherAdapter


# ── fakes ──────────────────────────────────────────────────────────────
@dataclass
class FakeEmailAdapter:
    sent: list[dict[str, Any]] = field(default_factory=list)

    def send(self, to: str, subject: str, body_text: str, body_html: str | None = None) -> str:
        message_id = f"msg_fake_{len(self.sent) + 1:04d}"
        self.sent.append({"message_id": message_id, "to": to, "subject": subject, "body_text": body_text})
        return message_id


DEFAULT_HUMAN_EVENTS: list[dict[str, Any]] = [
    {"event_id": "evt_human_dentist", "title": "Dentist", "weekday": 2, "hour": 9, "hours": 1},
    {"event_id": "evt_human_standup", "title": "Team standup", "weekday": 0, "hour": 10, "hours": 1},
]


@dataclass
class FakeCalendarAdapter:
    """In-memory calendar. ``human_events`` recur weekly and are owned by the human."""

    human_events: list[dict[str, Any]] = field(default_factory=lambda: list(DEFAULT_HUMAN_EVENTS))
    events: dict[str, dict[str, Any]] = field(default_factory=dict)
    log: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    _n: int = 0

    def create_event(self, *, title: str, start: str, end: str, attendee_emails: list[str],
                     location: str | None, description: str | None, owner: str) -> dict[str, Any]:
        self._n += 1
        event_id = f"evt_fake_{self._n:03d}"
        self.events[event_id] = {"event_id": event_id, "title": title, "start": start, "end": end,
                                 "attendees": attendee_emails, "location": location,
                                 "description": description, "butler_owner": owner}
        self.log.append(("create", dict(self.events[event_id])))
        return {"event_id": event_id, "html_link": f"https://calendar.fake.example/event/{event_id}"}

    def _human(self, event_id: str) -> dict[str, Any] | None:
        return next((h for h in self.human_events if h["event_id"] == event_id), None)

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        if event_id in self.events:
            return dict(self.events[event_id])
        h = self._human(event_id)
        if h:
            return {"event_id": event_id, "title": h["title"], "butler_owner": "human"}
        return None

    def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        self.events[event_id].update({k: v for k, v in fields.items() if v is not None})
        self.log.append(("update", {"event_id": event_id, **fields}))
        return dict(self.events[event_id])

    def delete_event(self, event_id: str) -> None:
        self.events.pop(event_id, None)
        self.log.append(("delete", {"event_id": event_id}))

    def list_events(self, time_min: str, time_max: str) -> list[dict[str, Any]]:
        lo, hi = parse_instant(time_min, DEFAULT_TZ), parse_instant(time_max, DEFAULT_TZ, end_of_day=True)
        out = [dict(e) for e in self.events.values()
               if lo < parse_instant(e["end"], DEFAULT_TZ) and parse_instant(e["start"], DEFAULT_TZ) < hi]
        day = lo.date()
        while day <= hi.date():
            for h in self.human_events:
                if day.weekday() == h["weekday"]:
                    start = at(day, time(h["hour"]), DEFAULT_TZ)
                    if lo < start + timedelta(hours=h["hours"]) and start < hi:
                        out.append({"event_id": h["event_id"], "title": h["title"],
                                    "start": start.isoformat(), "end": (start + timedelta(hours=h["hours"])).isoformat(),
                                    "butler_owner": "human"})
            day += timedelta(days=1)
        return sorted(out, key=lambda e: e["start"])


@dataclass
class FakePaymentAdapter:
    charges: list[dict[str, Any]] = field(default_factory=list)
    refunds: list[dict[str, Any]] = field(default_factory=list)

    def charge(self, amount_minor: int, currency: str, description: str, idempotency_key: str,
               metadata: dict[str, str]) -> str:
        ref = f"pi_test_{len(self.charges) + 1}"
        self.charges.append({"payment_ref": ref, "amount_minor": amount_minor, "currency": currency,
                             "description": description, "metadata": metadata})
        return ref

    def refund(self, payment_ref: str, amount_minor: int, idempotency_key: str) -> str:
        ref = f"re_test_{len(self.refunds) + 1}"
        self.refunds.append({"refund_ref": ref, "payment_ref": payment_ref, "amount_minor": amount_minor})
        return ref


class FakeWeatherAdapter:
    """Deterministic forecast derived from the date (no network)."""

    def forecast(self, date: str, lat: float, lon: float) -> dict[str, Any]:
        return fallback_forecast(date)


def fallback_forecast(date: str) -> dict[str, Any]:
    seed = sum(ord(c) for c in date[:10])
    high = 14 + seed % 10
    precip = (seed * 7) % 60
    summary = "Mild with a chance of showers" if precip >= 40 else "Mild and mostly dry"
    return {"summary": summary, "high_c": float(high), "low_c": float(high - 7), "precip_prob": precip / 100,
            "source": "fallback"}


def fake_adapters() -> Adapters:
    return Adapters(FakeEmailAdapter(), FakeCalendarAdapter(), FakePaymentAdapter(), FakeWeatherAdapter())


def default_adapters(mode: Literal["fake", "real"] | None = None) -> Adapters:
    """``ADAPTERS=fake|real`` (default fake). Weather stays deterministic unless ``WEATHER_MODE=live``
    (real mode always uses Open-Meteo)."""
    mode = mode or os.environ.get("ADAPTERS", "fake")  # type: ignore[assignment]
    if mode == "fake":
        adapters = fake_adapters()
        if os.environ.get("WEATHER_MODE") == "live":
            from .real_adapters import OpenMeteoWeatherAdapter
            adapters.weather = OpenMeteoWeatherAdapter()
        return adapters
    from .real_adapters import real_adapters
    return real_adapters()


_shared: dict[str, Adapters] = {}


def shared_adapters() -> Adapters:
    """Process-wide adapters used by ``dispatch`` when none are passed (so fake logs persist)."""
    mode = os.environ.get("ADAPTERS", "fake")
    if mode not in _shared:
        _shared[mode] = default_adapters(mode)  # type: ignore[arg-type]
    return _shared[mode]

