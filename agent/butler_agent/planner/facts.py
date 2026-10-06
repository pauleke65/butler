"""Facts the scripted planner derives from the plan text: who, when, how many (deterministic parsing)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from butler_contracts.models import Contact, Plan

WEEKDAYS = {"monday": 0, "mon": 0, "tuesday": 1, "tue": 1, "tues": 1, "wednesday": 2, "wed": 2, "thursday": 3,
            "thu": 3, "thur": 3, "thurs": 3, "friday": 4, "fri": 4, "saturday": 5, "sat": 5, "sunday": 6, "sun": 6}
NUMBER_WORDS = {w: i for i, w in enumerate(
    ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"])}
RELATIONSHIP_WORDS = {"friends": "friend", "friend": "friend", "family": "family", "coworkers": "work",
                      "colleagues": "work", "co-workers": "work", "team": "work"}
_TIME_RE = re.compile(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b", re.IGNORECASE)


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def _has_phrase(text: str, phrase: str) -> bool:
    return re.search(rf"\b{re.escape(phrase.lower())}\b", text.lower()) is not None


def resolve_people(text: str, contacts: list[Contact]) -> list[Contact]:
    """Contacts named in ``text`` (by first name or tag phrase); relationship words only as a fallback."""
    hit: set[str] = set()
    for c in contacts:
        if _has_phrase(text, c.first_name) or _has_phrase(text, c.name):
            hit.add(c.contact_id)
        for tag in c.tags or []:
            variants = {tag, tag.replace("-", " "), tag.rstrip("s"), tag.replace("-", " ").rstrip("s")}
            if any(_has_phrase(text, v) for v in variants if v):
                hit.update(x.contact_id for x in contacts if tag in (x.tags or []))
    if not hit:
        for word, rel in RELATIONSHIP_WORDS.items():
            if _has_phrase(text, word):
                hit.update(x.contact_id for x in contacts if x.relationship == rel)
    return [c for c in contacts if c.contact_id in hit]


def stated_count(text: str) -> int | None:
    """"six friends" -> 6, "5 people" -> 5 (the number nearest a head-count noun)."""
    m = re.search(r"\b(\d{1,2}|" + "|".join(NUMBER_WORDS) + r")\s+(?:of\s+my\s+)?(?:\w+\s+){0,2}?(?:friends?|people|guests?|"
                  r"colleagues|coworkers|relatives|neighbou?rs|of us)\b", text.lower())
    if not m:
        return None
    return int(m[1]) if m[1].isdigit() else NUMBER_WORDS[m[1]]


def _next_weekday(today: date, weekday: int, *, strictly_after: bool = False) -> date:
    delta = (weekday - today.weekday()) % 7
    return today + timedelta(days=delta or (7 if strictly_after else 0))


def _clock(text: str, default: time) -> time:
    m = _TIME_RE.search(text)
    if not m:
        return default
    hour = int(m[1] or m[4])
    minute = int(m[2] or m[5] or 0)
    meridian = (m[3] or "").lower()
    if meridian:
        hour = hour % 12 + (12 if meridian == "pm" else 0)
    elif 1 <= hour <= 7:
        hour += 12  # "at 7" for a gathering means the evening
    return time(hour % 24, minute)


def parse_when(text: str, now: datetime, tz: str, *, default_start: time = time(19, 0)) -> tuple[datetime | None, datetime | None]:
    """Fallback when the plan carries no dates: first weekday named is the start, a second is the end."""
    zone = ZoneInfo(tz)
    today = now.astimezone(zone).date()
    found = [WEEKDAYS[w] for w in words(text) if w in WEEKDAYS]
    if not found:
        if _has_phrase(text, "tomorrow"):
            return datetime.combine(today + timedelta(days=1), _clock(text, default_start), zone), None
        if _has_phrase(text, "tonight") or _has_phrase(text, "today"):
            return datetime.combine(today, _clock(text, default_start), zone), None
        return None, None
    start_day = _next_weekday(today, found[0])
    start = datetime.combine(start_day, _clock(text, default_start), zone)
    end = None
    if len(found) > 1:
        end = datetime.combine(_next_weekday(start_day, found[1], strictly_after=True), time(18, 0), zone)
    return start, end


@dataclass
class Facts:
    plan: Plan
    tz: str
    host: str
    contacts: list[Contact]
    starts: datetime | None
    ends: datetime | None
    audience: list[Contact] = field(default_factory=list)
    stated_count: int | None = None

    @property
    def situation(self) -> str:
        return self.plan.situation

    def mentions(self, *keywords: str) -> bool:
        low = self.plan.situation.lower()
        return any(k in low for k in keywords)


def _aware(value: str | None, tz: str) -> datetime | None:
    if not value:
        return None
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo(tz))


def derive(plan: Plan, contacts: list[Contact], members: list[dict], tz: str, now: datetime) -> Facts:
    starts, ends = _aware(plan.starts_at, tz), _aware(plan.ends_at, tz)
    if starts is None:
        default = time(9, 0) if plan.kind == "away" else time(19, 0)
        starts, parsed_end = parse_when(plan.situation, now, tz, default_start=default)
        ends = ends or parsed_end
    host = (members[0].get("name") if members else None) or "your host"
    return Facts(plan, tz, str(host).split()[0], contacts, starts, ends,
                 resolve_people(plan.situation, contacts), stated_count(plan.situation))


def when_phrase(dt: datetime, now: datetime) -> str:
    """"Friday at 7 PM" / "tomorrow at 7 PM" (spoken style, contracts §15)."""
    local_now = now.astimezone(dt.tzinfo)
    clock = dt.strftime("%I:%M %p").lstrip("0").replace(":00", "")
    day = dt.strftime("%A")
    if dt.date() == local_now.date():
        day = "today"
    elif dt.date() == local_now.date() + timedelta(days=1):
        day = "tomorrow"
    return f"{day} at {clock}"
