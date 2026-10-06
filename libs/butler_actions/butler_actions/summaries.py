"""Receipt titles and spoken summaries (contracts §15). Every output passes ``lint_spoken``."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from butler_rules import dollars

from . import clock
from .lint import MAX_WORDS, lint_spoken

READ_ONLY_TOOLS = frozenset({
    "Calendar___list_events", "Supplies___search_products", "Services___search_providers", "Context___get_weather",
})
SERVICE_NOUN = {"cleaning": "a cleaner", "ride": "a ride", "repair": "a repair", "pet_care": "pet care"}
CATEGORY_NOUN = {"groceries": "groceries", "drinks": "drinks", "household": "household supplies",
                 "toiletries": "toiletries", "gifts": "gifts", "other": "supplies"}
ERROR_PHRASE = {
    "INVALID_INPUT": "something in the request didn't check out",
    "UPSTREAM_UNAVAILABLE": "the service isn't responding",
    "NOT_FOUND": "I couldn't find it",
    "UNAUTHORIZED": "I wasn't allowed to reach the service",
}
_LOWER_FIRST = {"the", "a", "an", "it", "it's", "this", "that", "there", "they", "your", "you", "we", "he", "she",
                "his", "her", "its", "these", "those", "you've", "they're", "one", "two", "three", "four", "five", "six", "seven",
                "eight", "nine", "ten", "eleven", "twelve", "no", "not", "some", "all", "both", "most"}
_HELD_PREFIXES = ("always ask me before ", "ask me before ")


def _target(tool: str) -> str:
    return tool.split("___", 1)[0]


def category_noun(args: dict[str, Any]) -> str:
    return CATEGORY_NOUN.get(str(args.get("category", "other")), "supplies")


def service_noun(args: dict[str, Any]) -> str:
    return SERVICE_NOUN.get(str(args.get("service_type", "")), "a service")


def speak_time(iso: str, now: datetime | None = None) -> str:
    """'7 PM Friday', '7:30 PM tomorrow', or '7 PM on October 16' (relative within 7 days)."""
    try:
        dt = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return "the scheduled time"
    ref = (now or clock.now()).astimezone(dt.tzinfo) if dt.tzinfo else (now or clock.now()).replace(tzinfo=None)
    days = (dt.date() - ref.date()).days
    hour = dt.hour % 12 or 12
    stamp = f"{hour} {'AM' if dt.hour < 12 else 'PM'}" if dt.minute == 0 else \
        f"{hour}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"
    if days == 0:
        return f"{stamp} today"
    if days == 1:
        return f"{stamp} tomorrow"
    if 1 < days < 7:
        return f"{stamp} {dt.strftime('%A')}"
    return f"{stamp} on {dt.strftime('%B')} {dt.day}"


def names_phrase(names: list[str]) -> str:
    """'Tolu', 'Tolu and Sam', 'Tolu, Sam and Ada', 'Tolu, Sam, Ada and 3 others' (max three names)."""
    if len(names) == 1:
        return names[0]
    if len(names) <= 3:
        return ", ".join(names[:-1]) + " and " + names[-1]
    rest = len(names) - 3
    return ", ".join(names[:3]) + f" and {rest} other{'s' if rest != 1 else ''}"


def _count_people(args: dict[str, Any], result: dict[str, Any] | None) -> tuple[int, list[str]]:
    names = [str(n) for n in (result or {}).get("sent_to_names", []) if n]
    sent = (result or {}).get("sent_to") or args.get("recipient_contact_ids") or []
    n = len(names) or len(sent) or 1
    return n, names


def _email_noun(args: dict[str, Any]) -> str:
    return {"invite": "invites", "reminder": "a reminder", "notice": "a notice"}.get(str(args.get("kind")), "an email")


# ── per-tool phrases ──────────────────────────────────────────────────────
def verb_phrase(tool: str, args: dict[str, Any]) -> str:
    """What the action is, as an infinitive: 'buy drinks'."""
    return {
        "Supplies___checkout": lambda: f"buy {category_noun(args)}",
        "Supplies___refund": lambda: "refund an order",
        "Services___book_service": lambda: f"book {service_noun(args)}",
        "Services___cancel_booking": lambda: "cancel a booking",
        "Messages___send_email": lambda: f"send {_email_noun(args)}",
        "Calendar___create_event": lambda: "add a calendar event",
        "Calendar___update_event": lambda: "change a calendar event",
        "Calendar___delete_event": lambda: "remove a calendar event",
        "Calendar___list_events": lambda: "check the calendar",
        "Supplies___search_products": lambda: f"search for {args.get('query', 'products')}",
        "Services___search_providers": lambda: f"look for {service_noun(args)}",
        "Context___get_weather": lambda: "check the weather",
    }.get(tool, lambda: "do that")()


def _gerund(tool: str, args: dict[str, Any]) -> str:
    verb, _, rest = verb_phrase(tool, args).partition(" ")
    ing = {"buy": "buying", "book": "booking", "send": "sending", "add": "adding", "change": "changing",
           "remove": "removing", "refund": "refunding", "cancel": "cancelling", "check": "checking",
           "search": "searching", "look": "looking", "do": "doing"}.get(verb, verb + "ing")
    return f"{ing} {rest}".strip()


def _past(tool: str, args: dict[str, Any]) -> str:
    verb, _, rest = verb_phrase(tool, args).partition(" ")
    past = {"buy": "bought", "book": "booked", "send": "sent", "add": "added", "change": "changed",
            "remove": "removed", "refund": "refunded", "cancel": "cancelled", "check": "checked",
            "search": "searched", "look": "looked", "do": "did"}.get(verb, verb + "ed")
    return f"{past} {rest}".strip()


def receipt_title(tool: str, status: str, args: dict[str, Any]) -> str:
    """Short card title: 'Bought drinks'; 'Tried to buy drinks' when it did not happen."""
    if status in ("held_for_approval", "blocked", "failed"):
        return "Tried to " + verb_phrase(tool, args)
    if tool == "Calendar___create_event" and args.get("title"):
        return f"Added {str(args['title'])[:40]} to the calendar"
    return _past(tool, args).capitalize()


def _done_phrase(tool: str, args: dict[str, Any], result: dict[str, Any] | None, now: datetime | None) -> str:
    amount = args.get("amount_minor")
    money = f" for {dollars(amount)}" if isinstance(amount, int) and not isinstance(amount, bool) else ""
    if tool == "Messages___send_email":
        n, names = _count_people(args, result)
        who = names_phrase(names) if names else f"{n} {'person' if n == 1 else 'people'}"
        return f"sent {_email_noun(args)} to {who}"
    if tool == "Calendar___create_event":
        title = str(args.get("title") or "an event")[:40]
        return f"added {title} to your calendar for {speak_time(str(args.get('start', '')), now)}"
    if tool == "Supplies___search_products":
        n = len((result or {}).get("products", []))
        return f"found {n} option{'s' if n != 1 else ''} for {args.get('query', 'that')}"
    if tool == "Services___search_providers":
        n = len((result or {}).get("providers", []))
        return f"found {n} provider{'s' if n != 1 else ''}"
    if tool == "Calendar___list_events":
        n = len((result or {}).get("events", []))
        return f"checked your calendar and found {n} event{'s' if n != 1 else ''}"
    if tool == "Context___get_weather":
        return "checked the weather"
    if tool == "Supplies___refund" and isinstance((result or {}).get("amount_minor"), int):
        return f"refunded your order for {dollars(result['amount_minor'])}"  # type: ignore[index]
    return _past(tool, args) + money


# ── sentence assembly ─────────────────────────────────────────────────────
def _reason(reasons: list[str]) -> str:
    if not reasons:
        return ""
    text = " ".join(reasons[0].replace("\n", " ").split()).rstrip(".!?;:, ")
    words = text.split()
    if words and words[0].lower() in _LOWER_FIRST:
        words[0] = words[0][0].lower() + words[0][1:]
    return " ".join(words[:12])


def _limit_clause(rule_texts: list[str]) -> str:
    for text in rule_texts:
        if not re.search(r"\b(more than|over)\b", text):
            continue
        m = re.search(r"(\d+) dollars?(?: (\d+))?", text)
        if m:
            return "Your spending limit allowed it." if m.group(2) else f"Your {m.group(1)} dollar limit allowed it."
    return ""


def held_tail(rule_texts: list[str]) -> str:
    """'buying drinks' from 'Ask me before buying drinks.'"""
    for text in rule_texts:
        low = text.strip().rstrip(".")
        for prefix in _HELD_PREFIXES:
            if low.lower().startswith(prefix):
                return low[len(prefix):]
    return ""


def _fit(parts: list[str]) -> str:
    """Join non-empty sentences; if too long or failing lint, drop the trailing ones."""
    parts = [p for p in parts if p]
    while parts:
        text = " ".join(parts)
        if len(text.split()) <= MAX_WORDS and not lint_spoken(text):
            return text
        parts = parts[:-1] if len(parts) > 1 else []
    return ""


def spoken_summary(tool: str, status: str, args: dict[str, Any], result: dict[str, Any] | None,
                   reasons: list[str], rule_texts: list[str], *, approved: bool = False,
                   error: dict[str, Any] | None = None, now: datetime | None = None) -> str:
    """One or two plain sentences for the receipt: outcome first, then the reason (contracts §15)."""
    if status == "executed":
        done = _done_phrase(tool, args, result, now)
        reason = _reason(reasons)
        clause = "You approved it." if approved else _limit_clause(rule_texts)
        read_only = tool in READ_ONLY_TOOLS
        first = f"I {done} because {reason}." if reason and not read_only else f"I {done}."
        candidates = [[first, clause], [f"I {done}.", clause], [f"I {done}."]]
    elif status == "held_for_approval":
        tail = held_tail(rule_texts)
        first = f"I held it because you asked me to check before {tail}." if tail else \
            "I held it because one of your rules says to check first."
        candidates = [[first], ["I held it because of one of your rules."]]
    elif status == "blocked":
        if error and error.get("code") == "DENIED_RETRY_BLOCKED":
            candidates = [["I didn't try that again because it was already blocked."]]
        else:
            rule = rule_texts[0].strip().rstrip(".") if rule_texts else ""
            rule = (rule[0].lower() + rule[1:]) if rule else ""
            candidates = [[f"I didn't go ahead because of your rule: {rule}."] if rule
                          else ["I didn't go ahead because it isn't allowed."],
                          ["I didn't go ahead because of one of your rules."]]
    elif status == "undone":
        candidates = [[f"I undid it: {_past(tool, args)}."], ["I undid it."]]
    else:
        why = ERROR_PHRASE.get((error or {}).get("code", ""), "something went wrong on my side")
        candidates = [[f"I couldn't {verb_phrase(tool, args)} because {why}."], ["I couldn't do that."]]
    for parts in candidates:
        text = _fit(parts)
        if text:
            return text
    return "Done."
