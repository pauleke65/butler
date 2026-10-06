"""Python rule matcher (contracts §9.5, D7): explains decisions and mirrors the compiled Cedar."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from butler_contracts.models import Rule

from .identities import PrincipalName
from .inputs import cedar_input
from .templates import TEMPLATES


@dataclass
class MatchResult:
    decision: str  # "ALLOW" | "DENY"
    rule_ids: list[str] = field(default_factory=list)
    rule_texts: list[str] = field(default_factory=list)
    effects: list[str] = field(default_factory=list)


def rule_fires(rule: Rule, principal: PrincipalName, tool: str, inp: dict[str, Any]) -> bool:
    """Would ``rule`` forbid this call? ``inp`` is the Cedar input projection."""
    spec = TEMPLATES[rule.template]
    if spec.agent_only and principal != "butler-agent":
        return False
    return tool in spec.scope(rule.params) and spec.fires(rule.params, inp)


def match(rules: list[Rule], principal: PrincipalName, tool: str, args: dict[str, Any]) -> MatchResult:
    """DENY if any active rule forbids the call (forbid wins); otherwise ALLOW."""
    inp = cedar_input(args)
    hits = [r for r in rules if r.active and rule_fires(r, principal, tool, inp)]
    if not hits:
        return MatchResult("ALLOW")
    return MatchResult("DENY", [r.rule_id for r in hits], [r.text for r in hits], [r.effect for r in hits])
