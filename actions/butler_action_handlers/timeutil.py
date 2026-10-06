"""Time helpers: delivery windows, next-occurrence slots, household timezone."""
from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

DEFAULT_TZ = "America/New_York"
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_TIME_RE = re.compile(r"(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?", re.IGNORECASE)


def _to_hour(hour: int, minute: int, meridian: str | None) -> tuple[int, int]:
    if meridian:
        hour = hour % 12 + (12 if meridian.upper() == "PM" else 0)
    return hour, minute


def parse_window(window: str) -> tuple[time, time]:
    """"12-2 PM" -> (12:00, 14:00); "9 AM-12 PM" -> (09:00, 12:00)."""
    left, _, right = (p.strip() for p in window.partition("-"))
    r = _TIME_RE.fullmatch(right)
    if not r:
        raise ValueError(f"bad delivery window: {window!r}")
    end_h, end_m = _to_hour(int(r[1]), int(r[2] or 0), r[3])
    lm = _TIME_RE.fullmatch(left)
    if not lm:
        raise ValueError(f"bad delivery window: {window!r}")
    start_h, start_m = _to_hour(int(lm[1]), int(lm[2] or 0), lm[3] or r[3])
    if not lm[3] and (start_h, start_m) > (end_h, end_m):  # "11-1 PM": the start is the morning
        start_h, start_m = _to_hour(int(lm[1]), int(lm[2] or 0), "AM")
    return time(start_h, start_m), time(end_h, end_m)


def next_weekday(today: date, weekday: int) -> date:
    return today + timedelta(days=(weekday - today.weekday()) % 7)


def to_local(dt: datetime, tz: str) -> datetime:
    return dt.astimezone(ZoneInfo(tz))


def at(day: date, t: time, tz: str) -> datetime:
    return datetime.combine(day, t, tzinfo=ZoneInfo(tz))


def parse_instant(value: str, tz: str, *, end_of_day: bool = False) -> datetime:
    """ISO datetime (offset optional) or plain date, as an aware datetime in ``tz``."""
    if len(value) == 10:
        d = date.fromisoformat(value)
        return at(d, time(23, 59) if end_of_day else time(0, 0), tz)
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(tz))


def delivery_eta(delivery: dict, now: datetime, tz: str) -> tuple[datetime, str]:
    """Resolve a catalogue delivery spec to (eta, human label). The ETA is the end of the window."""
    local_now = to_local(now, tz)
    _, window_end = parse_window(delivery["window"])
    if "weekday" in delivery:
        day = next_weekday(local_now.date(), delivery["weekday"])
        if day == local_now.date() and at(day, window_end, tz) <= local_now:
            day += timedelta(days=7)
        name = WEEKDAYS[day.weekday()]
    else:
        day = local_now.date() + timedelta(days=int(delivery["days"]))
        name = "Tomorrow" if delivery["days"] == 1 else WEEKDAYS[day.weekday()]
    return at(day, window_end, tz), f"{name} {delivery['window']}"


def next_slot(weekday: int, hour: int, now: datetime, tz: str) -> datetime:
    """Next occurrence of weekday/hour strictly after ``now`` in the household timezone."""
    local_now = to_local(now, tz)
    day = next_weekday(local_now.date(), weekday)
    slot = at(day, time(hour, 0), tz)
    return slot if slot > local_now else slot + timedelta(days=7)
