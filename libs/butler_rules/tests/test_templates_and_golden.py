import json
import os
from pathlib import Path

import cedarpy
import pytest
from butler_contracts.models import RuleDraft
from butler_rules import (
    DEFAULT_RULE_IDS,
    GATEWAY_TOOLS,
    TEMPLATES,
    Identities,
    RuleParamError,
    base_policy,
    compile_rule,
    default_rules,
    draft_to_rule,
    validate_params,
)
from rules_cases import GOLDEN_PARAMS, NOW, make_rule

GOLDEN = Path(__file__).resolve().parents[3] / "policies" / "golden"
PLACEHOLDERS = Identities("{{AGENT_SUB}}", "{{EXECUTOR_SUB}}", "{{GATEWAY_ARN}}")


def _check_golden(name: str, text: str) -> None:
    path = GOLDEN / f"{name}.cedar"
    if os.environ.get("UPDATE_GOLDEN") == "1":
        GOLDEN.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    assert path.read_text() == text, f"golden mismatch for {name}; rerun with UPDATE_GOLDEN=1 if intended"


def test_all_seven_templates_present():
    assert set(TEMPLATES) == set(GOLDEN_PARAMS)
    assert {t.effect for t in TEMPLATES.values()} == {"ask_first", "never"}


@pytest.mark.parametrize("template", sorted(GOLDEN_PARAMS))
def test_golden_cedar(template):
    rule = make_rule(template, GOLDEN_PARAMS[template], PLACEHOLDERS, rule_id="rule_golden")
    _check_golden(template, compile_rule(rule, PLACEHOLDERS))


def test_golden_base_policy():
    _check_golden("base", base_policy(PLACEHOLDERS))


@pytest.mark.parametrize("template", sorted(GOLDEN_PARAMS))
def test_compiled_cedar_parses_and_carries_id(template, ids):
    text = compile_rule(make_rule(template, GOLDEN_PARAMS[template], ids, rule_id="rule_abc"), ids)
    pols = json.loads(cedarpy.policies_to_json_str(text))["staticPolicies"]
    assert [p["annotations"]["id"] for p in pols.values()] == ["rule_abc"]
    assert all(p["effect"] == "forbid" for p in pols.values())


@pytest.mark.parametrize("template", sorted(GOLDEN_PARAMS))
def test_every_input_access_is_guarded(template, ids):
    text = compile_rule(make_rule(template, GOLDEN_PARAMS[template], ids), ids)
    if "context.input" in text.replace("context.input has", ""):
        assert "context has input" in text
    for line in text.splitlines():
        if "getTag" in line:
            assert 'hasTag("sub")' in text
    # every `context.input.x` use is preceded by `context.input has x` in the same condition
    import re
    for m in re.finditer(r"context\.input\.(\w+)", text):
        assert f"context.input has {m.group(1)}" in text[: m.start()]


def test_spend_cap_single_tool_uses_equality(ids):
    r = make_rule("spend_cap", {"tools": ["Supplies___checkout"], "cap_minor": 2500}, ids)
    assert 'action == AgentCore::Action::"Supplies___checkout"' in r.cedar_statement
    assert TEMPLATES["spend_cap"].text(r.params) == "Ask me before buying anything over 25 dollars."


def test_base_policy_matches_contract(ids):
    text = base_policy(ids)
    assert text.startswith('@id("base-permit")\npermit (principal, action, resource is AgentCore::Gateway)')
    assert '"local-agent" || principal.getTag("sub") == "local-executor"' in text


def test_default_rules_exact(ids):
    rules = default_rules("hh_demo", ids, NOW)
    assert [r.rule_id for r in rules] == list(DEFAULT_RULE_IDS) == [
        "rule_default_spend", "rule_default_contacts", "rule_default_calendar", "rule_default_services",
        "rule_default_refunds",
    ]
    assert [r.text for r in rules] == [
        "Ask me before spending more than 50 dollars.",
        "Ask me before messaging anyone who isn't a saved contact.",
        "Never change or delete events I created.",
        "Always ask me before booking a service.",
        "Ask me before refunding anything.",
    ]
    assert [r.template for r in rules] == ["spend_cap", "ask_non_contact", "protect_human_events", "ask_tool", "ask_tool"]
    assert [r.effect for r in rules] == ["ask_first", "ask_first", "never", "ask_first", "ask_first"]
    assert all(r.origin.type == "default" and f'@id("{r.rule_id}")' in r.cedar_statement for r in rules)
    # builder text agrees with the default text where the contract wording equals the canonical wording
    assert TEMPLATES["spend_cap"].text(rules[0].params) == rules[0].text


BAD = [
    ("spend_cap", {"tools": [], "cap_minor": 5}),
    ("spend_cap", {"tools": ["Messages___send_email"], "cap_minor": 5}),
    ("spend_cap", {"tools": ["Supplies___checkout"], "cap_minor": -1}),
    ("spend_cap", {"tools": ["Supplies___checkout"], "cap_minor": 50.5}),
    ("spend_cap", {"tools": ["Supplies___checkout"], "cap_minor": True}),
    ("spend_cap", {"tools": ["Supplies___checkout", "Supplies___checkout"], "cap_minor": 5}),
    ("spend_cap", {"tools": ["Supplies___checkout"]}),
    ("ask_category", {"category": "pizza"}),
    ("ask_category", {}),
    ("ask_tool", {"tool": "Nope___x"}),
    ("never_tool", {"tool": 'Supplies___checkout" || true'}),
    ("ask_non_contact", {"x": 1}),
    ("protect_human_events", {"x": 1}),
    ("never_contact", {"contact_id": 'c_x") || true || ("'}),
    ("never_contact", {"contact_id": ""}),
    ("never_contact", {"contact_id": "c_ok", "extra": 1}),
    ("nonsense", {}),
]


@pytest.mark.parametrize(("template", "params"), BAD)
def test_validate_params_rejects(template, params):
    with pytest.raises(RuleParamError):
        validate_params(template, params)


def test_validate_params_accepts_golden():
    for t, p in GOLDEN_PARAMS.items():
        validate_params(t, p)


def test_every_gateway_tool_valid_for_tool_templates():
    for tool in GATEWAY_TOOLS:
        validate_params("ask_tool", {"tool": tool})
        validate_params("never_tool", {"tool": tool})


def test_draft_to_rule(ids):
    draft = RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                      effect="never", confidence=0.9)  # wrong effect from the model is overridden by the template
    rule = draft_to_rule(draft, "hh_t", origin={"type": "correction", "utterance": "no drinks", "created_at": NOW},
                         now=NOW, ids=ids)
    assert rule.rule_id.startswith("rule_") and rule.effect == "ask_first"
    assert rule.policy_status == "draft" and not rule.active
    assert f'@id("{rule.rule_id}")' in rule.cedar_statement and '"drinks"' in rule.cedar_statement
    assert rule.text == "Ask me before buying drinks."


def test_draft_to_rule_falls_back_to_template_text_and_rejects_bad(ids):
    origin = {"type": "default"}
    draft = RuleDraft(template="spend_cap", params={"tools": ["Supplies___checkout"], "cap_minor": 2000}, text="",
                      effect="ask_first", confidence=0.9)
    assert draft_to_rule(draft, "hh", origin=origin, now=NOW, ids=ids).text == "Ask me before buying anything over 20 dollars."
    with pytest.raises(RuleParamError):
        draft_to_rule(RuleDraft(template="unsupported", params={}, text="x", effect="never", confidence=1),
                      "hh", origin=origin, now=NOW, ids=ids)
    with pytest.raises(RuleParamError):
        draft_to_rule(RuleDraft(template="ask_category", params={"category": "x"}, text="x", effect="never",
                                confidence=1), "hh", origin=origin, now=NOW, ids=ids)
