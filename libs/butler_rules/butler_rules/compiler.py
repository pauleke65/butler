"""Rule compiler (contracts §9): Cedar text, base policy, drafts and default rules."""
from __future__ import annotations

from typing import Any

from butler_contracts.models import Rule, RuleDraft

from .identities import Identities
from .templates import AGENT_ONLY, TEMPLATES, RuleParamError, TemplateSpec, action_ref, validate_params

DEFAULT_TEXT_MAX = 140


def base_policy(ids: Identities) -> str:
    """Contracts §9.2: permit both known principals; every other rule is a forbid on top."""
    return (
        '@id("base-permit")\n'
        "permit (principal, action, resource is AgentCore::Gateway)\n"
        "when {\n"
        '  principal.hasTag("sub") &&\n'
        f'  (principal.getTag("sub") == "{ids.agent_sub}" || principal.getTag("sub") == "{ids.executor_sub}")\n'
        "};\n"
    )


def _action_clause(tools: tuple[str, ...]) -> str:
    if len(tools) == 1:
        return f"action == {action_ref(tools[0])}"
    return "action in [" + ", ".join(action_ref(t) for t in tools) + "]"


def _policy(rule_id: str, spec: TemplateSpec, params: dict[str, Any], ids: Identities) -> str:
    conds: list[str] = []
    if spec.agent_only:
        conds.append(AGENT_ONLY.format(agent_sub=ids.agent_sub))
    conds += spec.cedar_conditions(params)
    out = (
        f'@id("{rule_id}")\n'
        "forbid (\n"
        "  principal,\n"
        f"  {_action_clause(spec.scope(params))},\n"
        "  resource is AgentCore::Gateway\n"
        ")"
    )
    if conds:
        out += "\nwhen {\n  " + " &&\n  ".join(conds) + "\n}"
    return out + ";\n"


def compile_params(rule_id: str, template: str, params: dict[str, Any], ids: Identities) -> str:
    """Validate and compile; the only way Cedar is produced (the model never writes Cedar)."""
    validate_params(template, params)
    if not rule_id.replace("_", "").replace("-", "").isalnum():
        raise RuleParamError("rule_id must be alphanumeric with _ or -")
    return _policy(rule_id, TEMPLATES[template], params, ids)  # type: ignore[index]


def compile_rule(rule: Rule, ids: Identities) -> str:
    """Cedar text for ``rule``; every policy carries ``@id("<rule_id>")``."""
    return compile_params(rule.rule_id, rule.template, rule.params, ids)


def _new_rule_id() -> str:
    from butler_actions.ids import new_id  # lazy: butler_actions depends on this package

    return new_id("rule")


def draft_to_rule(draft: RuleDraft, household_id: str, *, origin: Any, now: str,
                  ids: Identities | None = None, rule_id: str | None = None) -> Rule:
    """Turn a validated model draft into a draft ``Rule`` (Cedar compiled here, effect set by template)."""
    ids = ids or Identities.from_env()
    if draft.template == "unsupported":
        raise RuleParamError("unsupported correction")
    validate_params(draft.template, draft.params)
    spec = TEMPLATES[draft.template]
    rid = rule_id or _new_rule_id()
    text = (draft.text or "").strip()
    if not text or len(text) > DEFAULT_TEXT_MAX or "\n" in text:
        text = spec.text(draft.params)
    return Rule(
        rule_id=rid, household_id=household_id, text=text, effect=spec.effect, template=draft.template,
        params=dict(draft.params), cedar_statement=_policy(rid, spec, draft.params, ids), policy_status="draft",
        origin=origin, active=False, created_at=now, updated_at=now,
    )


_DEFAULTS: list[tuple[str, str, str, dict[str, Any]]] = [
    ("rule_default_spend", "Ask me before spending more than 50 dollars.", "spend_cap",
     {"tools": ["Supplies___checkout", "Services___book_service"], "cap_minor": 5000}),
    ("rule_default_contacts", "Ask me before messaging anyone who isn't a saved contact.", "ask_non_contact", {}),
    ("rule_default_calendar", "Never change or delete events I created.", "protect_human_events", {}),
    ("rule_default_services", "Always ask me before booking a service.", "ask_tool",
     {"tool": "Services___book_service"}),
    ("rule_default_refunds", "Ask me before refunding anything.", "ask_tool", {"tool": "Supplies___refund"}),
]
DEFAULT_RULE_IDS = tuple(d[0] for d in _DEFAULTS)


def default_rules(household_id: str, ids: Identities, now: str) -> list[Rule]:
    """The five seeded rules of contracts §9.4 (not yet deployed: ``policy_status="draft"``)."""
    rules = []
    for rid, text, template, params in _DEFAULTS:
        spec = TEMPLATES[template]  # type: ignore[index]
        rules.append(Rule(
            rule_id=rid, household_id=household_id, text=text, effect=spec.effect, template=template,  # type: ignore[arg-type]
            params=params, cedar_statement=_policy(rid, spec, params, ids), policy_status="draft",
            origin={"type": "default"}, active=False, created_at=now, updated_at=now,  # type: ignore[arg-type]
        ))
    return rules
