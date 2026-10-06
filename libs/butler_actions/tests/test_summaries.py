from datetime import UTC, datetime

import pytest
from butler_actions.lint import lint_spoken
from butler_actions.summaries import names_phrase, receipt_title, speak_time, spoken_summary

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)  # a Tuesday
SPEND = "Ask me before spending more than 50 dollars."

CASES = [
    # tool, status, args, result, reasons, rule_texts, expected substring
    ("Supplies___checkout", "executed", {"amount_minor": 4200, "category": "drinks"}, {"order_id": "o"},
     ["Six guests are coming"], [SPEND], "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it."),
    ("Supplies___checkout", "executed", {"amount_minor": 4250, "category": "groceries"}, None, [], [], "I bought groceries for 42 dollars 50."),
    ("Supplies___checkout", "held_for_approval", {"amount_minor": 5200, "category": "drinks"}, None, [],
     ["Ask me before buying drinks."], "I held it because you asked me to check before buying drinks."),
    ("Services___book_service", "held_for_approval", {"service_type": "cleaning", "amount_minor": 9000}, None, [],
     ["Always ask me before booking a service."], "check before booking a service."),
    ("Calendar___delete_event", "blocked", {"event_id": "e", "event_owner": "human"}, None, [],
     ["Never change or delete events I created."], "because of your rule: never change or delete events I created."),
    ("Messages___send_email", "executed", {"kind": "invite", "recipient_contact_ids": ["a", "b", "c", "d", "e", "f"]},
     {"sent_to": ["a", "b", "c", "d", "e", "f"]}, ["You asked me to invite them"], [], "I sent invites to 6 people because you asked me to invite them."),
    ("Messages___send_email", "executed", {"kind": "invite"}, {"sent_to_names": ["Tolu", "Sam", "Ada", "Maya", "Dee"]},
     [], [], "I sent invites to Tolu, Sam, Ada and 2 others."),
    ("Calendar___create_event", "executed", {"title": "Dinner for six", "start": "2026-10-09T19:00:00-04:00"}, {"event_id": "e"},
     ["It's on your list"], [], "I added Dinner for six to your calendar for 7 PM Friday because it's on your list."),
    ("Supplies___refund", "executed", {"order_id": "o"}, {"amount_minor": 4200}, [], [], "I refunded your order for 42 dollars."),
    ("Supplies___search_products", "executed", {"query": "cola"}, {"products": [1, 2, 3]}, ["Need drinks"], [], "I found 3 options for cola."),
    ("Context___get_weather", "executed", {"date": "2026-10-09"}, {"summary": "x"}, [], [], "I checked the weather."),
    ("Supplies___checkout", "executed", {"amount_minor": 3100, "category": "drinks"}, {}, ["x"], [], "You approved it."),
    ("Supplies___checkout", "failed", {"amount_minor": 3100, "category": "drinks"}, None, [], [], "I couldn't buy drinks because"),
    ("Services___book_service", "failed", {"service_type": "cleaning"}, None, [], [], "I couldn't book a cleaner"),
    ("Supplies___checkout", "blocked", {"amount_minor": 1, "category": "drinks"}, None, [], [], "isn't allowed"),
]


@pytest.mark.parametrize(("tool", "status", "args", "result", "reasons", "rules", "expected"), CASES)
def test_summaries_render_and_lint(tool, status, args, result, reasons, rules, expected):
    approved = "approved" in expected
    text = spoken_summary(tool, status, args, result, reasons, rules, approved=approved, now=NOW,
                          error={"code": "UPSTREAM_UNAVAILABLE"} if status == "failed" else None)
    assert expected in text, text
    assert lint_spoken(text) == [], text


def test_long_reason_is_clipped_to_budget():
    text = spoken_summary("Supplies___checkout", "executed", {"amount_minor": 4200, "category": "drinks"}, {},
                          ["A very long winded explanation " * 10], ["Ask me before spending more than 50 dollars."], now=NOW)
    assert lint_spoken(text) == [] and len(text.split()) <= 35


def test_retry_blocked_summary():
    text = spoken_summary("Supplies___checkout", "blocked", {}, None, [], [], error={"code": "DENIED_RETRY_BLOCKED"})
    assert "again" in text and lint_spoken(text) == []


def test_titles():
    assert receipt_title("Supplies___checkout", "executed", {"category": "drinks"}) == "Bought drinks"
    assert receipt_title("Supplies___checkout", "held_for_approval", {"category": "drinks"}) == "Tried to buy drinks"
    assert receipt_title("Services___book_service", "executed", {"service_type": "cleaning"}) == "Booked a cleaner"
    assert receipt_title("Messages___send_email", "executed", {"kind": "invite"}) == "Sent invites"
    assert receipt_title("Calendar___create_event", "executed", {"title": "Dinner"}) == "Added Dinner to the calendar"


def test_speak_time_and_names():
    assert speak_time("2026-10-06T19:00:00+00:00", NOW) == "7 PM today"
    assert speak_time("2026-10-07T09:30:00+00:00", NOW) == "9:30 AM tomorrow"
    assert speak_time("2026-10-09T19:00:00-04:00", NOW) == "7 PM Friday"
    assert speak_time("2026-10-20T12:00:00+00:00", NOW) == "12 PM on October 20"
    assert speak_time("garbage", NOW) == "the scheduled time"
    assert names_phrase(["A"]) == "A" and names_phrase(["A", "B"]) == "A and B"
    assert names_phrase(["A", "B", "C", "D"]) == "A, B, C and 1 other"
