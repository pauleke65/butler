"""Injectable clock so tests and the demo can pin 'now'."""
from __future__ import annotations

import os
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

_fixed: datetime | None = None


def set_now(dt: datetime | None) -> None:
    global _fixed
    _fixed = dt


def now() -> datetime:
    if _fixed is not None:
        return _fixed
    env = os.environ.get("BUTLER_NOW")
    if env:
        return datetime.fromisoformat(env)
    return datetime.now(UTC)


def iso(dt: datetime | None = None, tz: str | None = None) -> str:
    d = dt or now()
    if tz:
        d = d.astimezone(ZoneInfo(tz))
    return d.isoformat(timespec="seconds")
