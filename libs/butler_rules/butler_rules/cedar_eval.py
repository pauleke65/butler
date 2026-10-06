"""Real Cedar evaluation via cedarpy: the local Gateway and the parity tests use this."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

import cedarpy
from butler_contracts.models import Rule

from .compiler import base_policy, compile_rule
from .identities import Identities, PrincipalName
from .inputs import cedar_input

PRINCIPAL_TYPE = "AgentCore::OAuthUser"
GATEWAY_TYPE = "AgentCore::Gateway"
ACTION_TYPE = "AgentCore::Action"
BASE_ID = "base-permit"


@dataclass
class CedarResult:
    decision: Literal["ALLOW", "DENY"]
    determining: list[str] = field(default_factory=list)  # @id of determining forbid policies
    errors: list[str] = field(default_factory=list)  # policies Cedar skipped because they errored


class CedarEvaluator:
    """Default-deny + base permit + the household's active rules; forbid wins."""

    def __init__(self, rules: list[Rule], ids: Identities):
        self.ids = ids
        statements = [base_policy(ids)]
        statements += [r.cedar_statement or compile_rule(r, ids) for r in rules if r.active]
        self.policy_text = "\n".join(statements)
        self._policies = cedarpy.PolicySet.from_str(self.policy_text)
        parsed = json.loads(cedarpy.policies_to_json_str(self.policy_text))["staticPolicies"]
        self._ids = {pid: p.get("annotations", {}).get("id", pid) for pid, p in parsed.items()}

    def _entities(self, sub: str) -> list[dict[str, Any]]:
        return [
            {"uid": {"type": PRINCIPAL_TYPE, "id": f"user-{sub}"}, "attrs": {}, "parents": [], "tags": {"sub": sub}},
            {"uid": {"type": GATEWAY_TYPE, "id": self.ids.gateway_arn}, "attrs": {}, "parents": []},
        ]

    def evaluate(self, principal: PrincipalName, tool: str, args: dict[str, Any]) -> CedarResult:
        sub = self.ids.sub_for(principal)
        request = {
            "principal": {"type": PRINCIPAL_TYPE, "id": f"user-{sub}"},
            "action": {"type": ACTION_TYPE, "id": tool},
            "resource": {"type": GATEWAY_TYPE, "id": self.ids.gateway_arn},
            "context": {"input": cedar_input(args)},
        }
        res = cedarpy.is_authorized(request, self._policies, self._entities(sub))
        reasons = [self._ids.get(r, r) for r in res.diagnostics.reasons]
        errors = [str(e) for e in res.diagnostics.errors]
        if res.allowed:
            return CedarResult("ALLOW", [], errors)
        return CedarResult("DENY", sorted({r for r in reasons if r != BASE_ID}), errors)

    def authorize(self, principal: PrincipalName, tool: str, args: dict[str, Any]) -> tuple[Literal["ALLOW", "DENY"], list[str]]:
        r = self.evaluate(principal, tool, args)
        return r.decision, r.determining
