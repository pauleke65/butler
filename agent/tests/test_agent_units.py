"""Pure-function units: fact extraction, product choice, factory selection."""
from datetime import datetime

import pytest
from agent_support import NOW
from butler_agent.drafter import PatternRuleDrafter
from butler_agent.factory import build_drafter, build_planner
from butler_agent.planner.facts import parse_when, resolve_people, stated_count, when_phrase
from butler_agent.planner.scripted import ScriptedPlanner
from butler_agent.planner.shopping import capacity, choose_product, money, whole_dollars
from butler_agent.sandbox import NY
from butler_contracts.models import Contact


def c(cid, name, rel="friend", tags=None):
    return Contact(contact_id=cid, name=name, first_name=name, email=f"{name}@x.co", relationship=rel, tags=tags or [])


CONTACTS = [c("c_tolu", "Tolu", tags=["dinner-crew"]), c("c_sam", "Sam", tags=["dinner-crew"]), c("c_zed", "Zed"),
            c("c_mum", "Mum", "family", ["parents"]), c("c_dad", "Dad", "family", ["parents"]),
            c("c_jordan", "Jordan", "work", ["boss"])]


@pytest.mark.parametrize(("text", "expected"), [
    ("the dinner crew is coming", ["c_tolu", "c_sam"]),
    ("Tolu and Zed are coming", ["c_tolu", "c_zed"]),
    ("my parents are staying", ["c_mum", "c_dad"]),
    ("my boss is coming", ["c_jordan"]),
    ("a few friends are coming", ["c_tolu", "c_sam", "c_zed"]),  # relationship words only when nothing is named
    ("someone is coming", []),
])
def test_resolve_people(text, expected):
    assert [p.contact_id for p in resolve_people(text, CONTACTS)] == expected


def test_stated_count():
    assert stated_count("six friends are coming") == 6
    assert stated_count("5 people over") == 5 and stated_count("six friends from the dinner crew") == 6
    assert stated_count("nobody special") is None


def test_parse_when_weekdays_and_times():
    start, end = parse_when("coming over Friday at 7", NOW, "America/New_York")
    assert start == datetime(2026, 10, 16, 19, 0, tzinfo=NY) and end is None
    start, end = parse_when("I'm travelling Thursday to Sunday", NOW, "America/New_York")
    assert start.date().isoformat() == "2026-10-15" and end.date().isoformat() == "2026-10-18"
    assert parse_when("dinner tomorrow at 8pm", NOW, "America/New_York")[0] == datetime(2026, 10, 13, 20, 0, tzinfo=NY)
    assert parse_when("sometime", NOW, "America/New_York") == (None, None)


def test_when_phrase_is_spoken_style():
    assert when_phrase(datetime(2026, 10, 16, 19, 0, tzinfo=NY), NOW) == "Friday at 7 PM"
    assert when_phrase(datetime(2026, 10, 13, 19, 30, tzinfo=NY), NOW) == "tomorrow at 7:30 PM"


def test_money_phrases():
    assert (money(4200), money(4250), money(100), whole_dollars(5000)) == ("42 dollars", "42 dollars 50", "1 dollar", "50 dollar")
    assert capacity("Drinks bundle for 7") == 7 and capacity("Drinks for a weekend, 3 people") == 3 and capacity("Milk") is None


def product(sku, merchant, price, label, name="Drinks bundle for 7"):
    return {"sku": sku, "merchant": merchant, "unit_price_minor": price, "delivery_label": label, "name": name}


def test_choose_product_rejects_with_reasons_and_prefers_the_known_merchant():
    items = [product("a", "BudgetBasket", 3600, "Saturday 9 AM-12 PM"), product("b", "FreshCart", 4200, "Friday 12-2 PM"),
             product("c", "Corner Cellar", 5800, "Friday 3-5 PM"), product("d", "FreshCart", 3100, "Thursday", "Drinks for a weekend, 3 people")]
    ch = choose_product(items, {"b", "c", "d"}, people=7, cap_minor=5000, preferred_merchant="FreshCart", deadline_phrase="after the party")
    assert ch.chosen["sku"] == "b" and not ch.fallback and ch.on_time_exists
    why = {a["option"].split()[0]: a["rejected_because"] for a in ch.alternatives}
    assert why["BudgetBasket"] == "Arrives Saturday, after the party" and why["Corner"] == "Over your 50 dollar limit"
    assert len(ch.alternatives) == 2  # the 3-person bundle is not a candidate for 7 people


def test_choose_product_falls_back_when_everything_is_over_the_cap_and_flags_nothing_on_time():
    over = [product("c", "Corner Cellar", 5800, "Friday 3-5 PM")]
    ch = choose_product(over, {"c"}, people=7, cap_minor=5000, preferred_merchant=None, deadline_phrase="x")
    assert ch.chosen["sku"] == "c" and ch.fallback  # attempt it: the policy decides, not the planner
    late = choose_product(over, set(), people=7, cap_minor=None, preferred_merchant=None, deadline_phrase="x")
    assert late.on_time_exists is False


def test_factory_picks_implementations_from_the_mode():
    assert isinstance(build_planner("offline"), ScriptedPlanner) and isinstance(build_drafter("offline"), PatternRuleDrafter)
    assert type(build_planner("bedrock")).__name__ == "StrandsPlanner"
    llm = build_drafter("bedrock")
    assert type(llm).__name__ == "LLMRuleDrafter" and isinstance(llm.fallback, PatternRuleDrafter)
