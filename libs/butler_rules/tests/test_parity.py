"""Parity matrix: the Python matcher must agree with real Cedar (cedarpy) on every case."""
import itertools

import pytest
from butler_rules import CedarEvaluator, default_rules, match
from rules_cases import GOLDEN_PARAMS, make_rule

CHECKOUT, BOOK, EMAIL = "Supplies___checkout", "Services___book_service", "Messages___send_email"
UPD, DEL, REFUND = "Calendar___update_event", "Calendar___delete_event", "Supplies___refund"

# (tool, args) call table: edge amounts, missing fields, contacts vs non-contacts, human vs butler events.
CALLS: list[tuple[str, dict]] = [
    *[(CHECKOUT, {"amount_minor": a, "category": "groceries"}) for a in (0, 1, 4999, 5000, 5001, 10_000_000)],
    *[(CHECKOUT, {"amount_minor": a, "category": "drinks"}) for a in (4999, 5000, 5001, 3100)],
    (CHECKOUT, {"category": "drinks"}),
    (CHECKOUT, {"amount_minor": 6000}),
    (CHECKOUT, {}),
    (CHECKOUT, {"amount_minor": 6000, "category": "other"}),
    (CHECKOUT, {"amount_minor": "6000", "category": "drinks"}),       # type-confused: Cedar errors, rule skipped
    (CHECKOUT, {"amount_minor": 6000.5, "category": "drinks"}),       # float: not representable, dropped
    (CHECKOUT, {"amount_minor": True, "category": "drinks"}),
    (CHECKOUT, {"amount_minor": None, "category": None}),
    (CHECKOUT, {"amount_minor": 4200, "category": "Drinks"}),         # case-sensitive
    (CHECKOUT, {"amount_minor": 4200, "category": ["drinks"]}),
    (CHECKOUT, {"amount_minor": 6000, "category": "drinks", "reasoning": {"reasons": ["x"]}}),
    *[(BOOK, {"amount_minor": a, "service_type": "cleaning"}) for a in (4999, 5000, 5001)],
    (BOOK, {"service_type": "cleaning"}),
    (BOOK, {"amount_minor": 100, "service_type": "ride"}),
    (EMAIL, {"recipient_email": "x@y.com", "subject": "s"}),
    (EMAIL, {"recipient_email": "", "subject": "s"}),
    (EMAIL, {"recipient_contact_ids": ["c_tolu"]}),
    (EMAIL, {"recipient_contact_ids": ["c_jordan"]}),
    (EMAIL, {"recipient_contact_ids": ["c_tolu", "c_jordan", "c_sam"]}),
    (EMAIL, {"recipient_contact_ids": []}),
    (EMAIL, {"recipient_contact_ids": "c_jordan"}),                   # type-confused
    (EMAIL, {"recipient_contact_ids": ["c_jordan"], "recipient_email": "j@x.com"}),
    (EMAIL, {"recipient_contact_ids": ["C_JORDAN"]}),
    (EMAIL, {}),
    *[(t, {"event_id": "e", "event_owner": o}) for t, o in itertools.product((UPD, DEL), ("human", "butler", "other"))],
    (UPD, {"event_id": "e"}),
    (DEL, {"event_id": "e", "event_owner": None}),
    (UPD, {"event_id": "e", "event_owner": 1}),
    ("Calendar___create_event", {"title": "t", "start": "2026-10-16T19:00:00-04:00", "event_owner": "human"}),
    ("Calendar___list_events", {"from": "a", "to": "b"}),
    (REFUND, {"order_id": "ord_1"}),
    ("Services___cancel_booking", {"booking_id": "b"}),
    ("Services___search_providers", {"service_type": "cleaning", "date": "2026-10-16"}),
    ("Supplies___search_products", {"query": "cola", "category": "drinks", "max_results": 3}),
    ("Context___get_weather", {"date": "2026-10-16", "lat": 40.7, "lon": -74.0}),
]

RULESETS: dict[str, list[tuple[str, dict]]] = {
    **{f"only-{t}": [(t, p)] for t, p in GOLDEN_PARAMS.items()},
    "spend-checkout-only-cap0": [("spend_cap", {"tools": [CHECKOUT], "cap_minor": 0})],
    "spend-book-only": [("spend_cap", {"tools": [BOOK], "cap_minor": 5000})],
    "ask-groceries": [("ask_category", {"category": "groceries"})],
    "never-other-contact": [("never_contact", {"contact_id": "c_sam"})],
    "never-refund": [("never_tool", {"tool": REFUND})],
    "ask-send-email": [("ask_tool", {"tool": EMAIL})],
    "never-weather": [("never_tool", {"tool": "Context___get_weather"})],
    "everything": [*GOLDEN_PARAMS.items(), ("ask_tool", {"tool": REFUND}), ("ask_category", {"category": "groceries"})],
    "none": [],
}


def _rules(spec, ids):
    return [make_rule(t, p, ids, rule_id=f"rule_{i}_{t}") for i, (t, p) in enumerate(spec)]


@pytest.mark.parametrize("ruleset", sorted(RULESETS))
@pytest.mark.parametrize("principal", ["butler-agent", "approval-executor"])
def test_matcher_equals_cedar(ruleset, principal, ids):
    rules = _rules(RULESETS[ruleset], ids)
    cedar = CedarEvaluator(rules, ids)
    for tool, args in CALLS:
        m = match(rules, principal, tool, args)
        decision, determining = cedar.authorize(principal, tool, args)
        ctx = f"{ruleset} {principal} {tool} {args}"
        assert m.decision == decision, ctx
        assert sorted(m.rule_ids) == sorted(determining), ctx


def test_defaults_matrix_with_expected_decisions(active_defaults, ids):
    cedar = CedarEvaluator(active_defaults, ids)
    expected = [  # principal, tool, args, decision, rule ids
        ("butler-agent", CHECKOUT, {"amount_minor": 4999, "category": "drinks"}, "ALLOW", []),
        ("butler-agent", CHECKOUT, {"amount_minor": 5000, "category": "drinks"}, "ALLOW", []),
        ("butler-agent", CHECKOUT, {"amount_minor": 5001, "category": "drinks"}, "DENY", ["rule_default_spend"]),
        ("approval-executor", CHECKOUT, {"amount_minor": 5200, "category": "drinks"}, "ALLOW", []),
        ("butler-agent", BOOK, {"amount_minor": 100}, "DENY", ["rule_default_services"]),
        ("butler-agent", BOOK, {"amount_minor": 9000}, "DENY", ["rule_default_services", "rule_default_spend"]),
        ("approval-executor", BOOK, {"amount_minor": 9000}, "ALLOW", []),
        ("butler-agent", REFUND, {"order_id": "o"}, "DENY", ["rule_default_refunds"]),
        ("approval-executor", REFUND, {"order_id": "o"}, "ALLOW", []),
        ("butler-agent", EMAIL, {"recipient_email": "x@y"}, "DENY", ["rule_default_contacts"]),
        ("approval-executor", EMAIL, {"recipient_email": "x@y"}, "ALLOW", []),
        ("butler-agent", EMAIL, {"recipient_contact_ids": ["c_tolu"]}, "ALLOW", []),
        ("butler-agent", UPD, {"event_owner": "human"}, "DENY", ["rule_default_calendar"]),
        ("approval-executor", DEL, {"event_owner": "human"}, "DENY", ["rule_default_calendar"]),
        ("butler-agent", UPD, {"event_owner": "butler"}, "ALLOW", []),
    ]
    for principal, tool, args, decision, rule_ids in expected:
        m = match(active_defaults, principal, tool, args)
        assert (m.decision, sorted(m.rule_ids)) == (decision, sorted(rule_ids)), (principal, tool, args)
        assert cedar.authorize(principal, tool, args) == (decision, sorted(rule_ids)), (principal, tool, args)
        assert len(m.rule_texts) == len(m.effects) == len(m.rule_ids)


def test_inactive_rules_are_ignored_by_both(ids):
    rules = [make_rule("never_tool", {"tool": REFUND}, ids, active=False)]
    assert match(rules, "butler-agent", REFUND, {}).decision == "ALLOW"
    assert CedarEvaluator(rules, ids).authorize("butler-agent", REFUND, {}) == ("ALLOW", [])


def test_never_covers_both_principals_ask_first_only_agent(ids):
    rules = [make_rule("never_contact", {"contact_id": "c_jordan"}, ids, rule_id="rule_never"),
             make_rule("ask_category", {"category": "drinks"}, ids, rule_id="rule_ask")]
    cedar = CedarEvaluator(rules, ids)
    drinks = {"amount_minor": 3100, "category": "drinks"}
    assert cedar.authorize("butler-agent", CHECKOUT, drinks) == ("DENY", ["rule_ask"])
    assert cedar.authorize("approval-executor", CHECKOUT, drinks) == ("ALLOW", [])
    mail = {"recipient_contact_ids": ["c_jordan"]}
    assert cedar.authorize("butler-agent", EMAIL, mail) == ("DENY", ["rule_never"])
    assert cedar.authorize("approval-executor", EMAIL, mail) == ("DENY", ["rule_never"])


def test_unknown_principal_is_default_denied(ids):
    from butler_rules import Identities
    rules = _rules([("never_tool", {"tool": REFUND})], ids)
    other = CedarEvaluator(rules, Identities("a", "b", ids.gateway_arn))
    # evaluator for different identities still permits its own principals, never an unknown one
    assert other.authorize("butler-agent", CHECKOUT, {})[0] == "ALLOW"
    res = CedarEvaluator([], ids)
    res.ids = Identities("someone-else", "x", ids.gateway_arn)
    assert res.authorize("butler-agent", CHECKOUT, {})[0] == "DENY"  # base permit does not cover this sub


def test_default_rules_cover_contract_defaults_in_cedar_only_from_cedar_statement(ids):
    # The evaluator evaluates what is stored on the rule (what is deployed), not a recompile.
    rules = [r.model_copy(update={"active": True}) for r in default_rules("hh", ids, "2026-10-06T00:00:00+00:00")]
    rules[0] = rules[0].model_copy(update={"cedar_statement": rules[0].cedar_statement.replace("5000", "100")})
    cedar = CedarEvaluator(rules, ids)
    assert cedar.authorize("butler-agent", CHECKOUT, {"amount_minor": 200, "category": "x"})[0] == "DENY"
    assert match(rules, "butler-agent", CHECKOUT, {"amount_minor": 200, "category": "x"}).decision == "ALLOW"
