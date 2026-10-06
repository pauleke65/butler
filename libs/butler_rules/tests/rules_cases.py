"""Shared sample rules and golden params for the rules tests."""
from butler_contracts.models import Rule

NOW = "2026-10-06T12:00:00+00:00"

GOLDEN_PARAMS: dict[str, dict] = {
    "spend_cap": {"tools": ["Supplies___checkout", "Services___book_service"], "cap_minor": 5000},
    "ask_category": {"category": "drinks"},
    "ask_tool": {"tool": "Services___book_service"},
    "ask_non_contact": {},
    "never_contact": {"contact_id": "c_jordan"},
    "protect_human_events": {},
    "never_tool": {"tool": "Supplies___checkout"},
}


def make_rule(template: str, params: dict, ids, *, rule_id: str = "rule_t", active: bool = True) -> Rule:
    from butler_rules import TEMPLATES, compile_params

    spec = TEMPLATES[template]
    return Rule(
        rule_id=rule_id, household_id="hh_t", text=spec.text(params), effect=spec.effect, template=template,
        params=params, cedar_statement=compile_params(rule_id, template, params, ids),
        policy_status="active" if active else "draft", origin={"type": "default"}, active=active,
        created_at=NOW, updated_at=NOW,
    )
