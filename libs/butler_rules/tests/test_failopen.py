"""Why guards matter: in Cedar a policy that errors is skipped, so an unguarded forbid fails open."""
import pytest
from butler_rules import CedarEvaluator, base_policy, policy_field_problems
from rules_cases import make_rule

AGENT = "Supplies___checkout"
UNGUARDED = f"""
@id("unguarded")
forbid (principal, action == AgentCore::Action::"{AGENT}", resource is AgentCore::Gateway)
when {{ principal.getTag("sub") == "local-agent" && context.input.amount_minor > 5000 }};
"""


def _evaluator(extra: str, ids):
    ev = CedarEvaluator([], ids)
    import cedarpy
    ev.policy_text = base_policy(ids) + extra
    ev._policies = cedarpy.PolicySet.from_str(ev.policy_text)
    ev._ids = {"policy0": "base-permit", "policy1": "unguarded"}
    return ev


def test_unguarded_forbid_fails_open_on_missing_field(ids):
    ev = _evaluator(UNGUARDED, ids)
    assert ev.evaluate("butler-agent", AGENT, {"amount_minor": 9000}).decision == "DENY"
    res = ev.evaluate("butler-agent", AGENT, {})  # field missing: the forbid errors and is skipped
    assert res.decision == "ALLOW" and any("amount_minor" in e for e in res.errors)


def test_guarded_forbid_is_error_free_and_still_denies(ids):
    rule = make_rule("spend_cap", {"tools": [AGENT], "cap_minor": 5000}, ids, rule_id="guarded")
    ev = CedarEvaluator([rule], ids)
    assert ev.evaluate("butler-agent", AGENT, {"amount_minor": 9000}).decision == "DENY"
    res = ev.evaluate("butler-agent", AGENT, {})
    assert res.decision == "ALLOW" and res.errors == []  # absent field: clean, deterministic non-match


def test_guarded_policy_still_errors_on_type_confusion(ids):
    """Guards cannot fix a wrong *type*; hence the fail-closed pre-check below."""
    rule = make_rule("spend_cap", {"tools": [AGENT], "cap_minor": 5000}, ids, rule_id="guarded")
    res = CedarEvaluator([rule], ids).evaluate("butler-agent", AGENT, {"amount_minor": "9000", "category": "x"})
    assert res.decision == "ALLOW" and res.errors


@pytest.mark.parametrize(("tool", "args", "problem"), [
    (AGENT, {"amount_minor": "9000", "category": "x"}, "amount_minor must be an integer"),
    (AGENT, {"amount_minor": 9000.5, "category": "x"}, "amount_minor must be an integer"),
    (AGENT, {"amount_minor": True, "category": "x"}, "amount_minor must be an integer"),
    (AGENT, {"category": "x"}, "amount_minor is required"),
    (AGENT, {"amount_minor": 1}, "category is required"),
    ("Calendar___update_event", {"event_id": "e"}, "event_owner is required"),
    ("Messages___send_email", {"subject": "s"}, "recipient_email or recipient_contact_ids is required"),
    ("Messages___send_email", {"recipient_contact_ids": "c_jordan"}, "recipient_contact_ids must be a list of strings"),
])
def test_policy_field_problems_fail_closed(tool, args, problem):
    assert problem in policy_field_problems(args, tool)


def test_policy_field_problems_clean_inputs():
    assert policy_field_problems({"amount_minor": 1, "category": "drinks"}, AGENT) == []
    assert policy_field_problems({"recipient_contact_ids": ["c"]}, "Messages___send_email") == []
    assert policy_field_problems({"lat": 1.5}, "Context___get_weather") == []
