"""LLMRuleDrafter: Bedrock tool-use structured output -> ``RuleDraft`` (prompt: prompts/rule_drafter.v1.md)."""
from __future__ import annotations

import json
import logging
from typing import Any

from butler_contracts.models import RuleDraft
from butler_rules import TEMPLATES, RuleParamError, validate_params
from pydantic import ValidationError

from . import prompts
from .config import RULE_CONFIDENCE_THRESHOLD, planner_model
from .drafter import DraftContext, RuleDrafter, make_draft, unsupported
from .llm import BedrockLLM, response_tool_uses

log = logging.getLogger("butler.drafter")

TOOL_NAME = "submit_rule_draft"
TOOL_SPEC = {
    "name": TOOL_NAME,
    "description": "Submit the single rule draft for the customer's correction.",
    "inputSchema": {"json": {
        "type": "object",
        "properties": {
            "template": {"type": "string", "enum": [*TEMPLATES, "unsupported"]},
            "params": {"type": "object"},
            "text": {"type": "string", "description": "One short sentence, e.g. 'Ask me before buying drinks.'"},
            "effect": {"type": "string", "enum": ["allow", "ask_first", "never"]},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        },
        "required": ["template", "params", "text", "effect", "confidence"],
    }},
}


class LLMRuleDrafter:
    def __init__(self, llm: BedrockLLM, model_id: str | None = None, fallback: RuleDrafter | None = None):
        self.llm, self.model_id, self.fallback = llm, model_id or planner_model(), fallback

    def draft(self, correction: str, ctx: DraftContext) -> RuleDraft:
        try:
            raw = self._ask(correction, ctx)
        except Exception:
            if self.fallback is None:
                raise
            log.exception("bedrock rule drafting failed; using the pattern drafter")
            return self.fallback.draft(correction, ctx)
        return self._validated(raw, ctx)

    def _ask(self, correction: str, ctx: DraftContext) -> dict[str, Any]:
        system, _ = prompts.load("rule_drafter")
        res = self.llm.converse(model_id=self.model_id, system=system, tools=[TOOL_SPEC], force_tool=TOOL_NAME,
                                max_tokens=600, messages=[{"role": "user", "content": [{"text": _user_message(correction, ctx)}]}])
        uses = response_tool_uses(res)
        if not uses:
            return {"template": "unsupported"}
        return uses[0]["input"]

    def _validated(self, raw: dict[str, Any], ctx: DraftContext) -> RuleDraft:
        template = raw.get("template")
        if template == "unsupported" or template not in TEMPLATES:
            return unsupported(float(raw.get("confidence", 0.0) or 0.0))
        params = raw.get("params") or {}
        if template == "never_contact":
            contact = next((c for c in ctx.contacts if c.contact_id == params.get("contact_id")), None)
            if contact is None:
                return unsupported()
            params = {"contact_id": contact.contact_id, "contact_name": contact.first_name}
        try:
            validate_params(template, params)
            # The rule text always comes from the template so it describes exactly what is enforced.
            return make_draft(template, params, float(raw.get("confidence", 0.0)))
        except (RuleParamError, ValidationError, TypeError, ValueError):
            log.warning("model produced an invalid draft: %s", raw)
            return unsupported()


def _user_message(correction: str, ctx: DraftContext) -> str:
    payload: dict[str, Any] = {
        "correction": correction,
        "contacts": [{"contact_id": c.contact_id, "name": c.name, "tags": c.tags or []} for c in ctx.contacts],
        "current_rules": [{"rule_id": r.rule_id, "text": r.text, "template": r.template, "params": r.params}
                          for r in ctx.rules],
    }
    if ctx.base_rule:
        payload["base_rule"] = {"rule_id": ctx.base_rule.rule_id, "text": ctx.base_rule.text,
                                "template": ctx.base_rule.template, "params": ctx.base_rule.params}
    if ctx.receipt:
        a = ctx.receipt.action
        payload["referenced_action"] = {"title": ctx.receipt.title, "tool": a.tool,
                                        "args": {k: v for k, v in a.args.items() if k in ("category", "merchant", "amount_minor", "service_type", "provider_id")}}
    return json.dumps(payload)


__all__ = ["RULE_CONFIDENCE_THRESHOLD", "LLMRuleDrafter"]
