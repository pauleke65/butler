"""StrandsPlanner: the LLM planner (LLM_MODE=bedrock).

A small hand-rolled tool-use loop on Bedrock Converse with exactly the tools of contracts §5.1 (local tools +
Gateway action tools through the wrapper). It is deliberately not tied to the Strands SDK so it runs anywhere;
the tool surface and loop rules are the same, so swapping in a Strands ``Agent`` is a drop-in change.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from butler_action_handlers import TOOLS
from butler_actions.store import Store
from pydantic import ValidationError

from . import prompts
from .config import planner_model
from .context import RunContext
from .guard import RunLimitExceeded
from .llm import BedrockLLM, response_blocks, response_tool_uses

log = logging.getLogger("butler.planner")

MAX_TURNS = 40
COMMON_FIELDS = {"plan_id", "idempotency_key", "correlation_id", "need_id"}
REASONING_SCHEMA = {
    "type": "object", "description": "Why you did this; copied to the customer's receipt.",
    "properties": {
        "reasons": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
        "context_used": {"type": "array", "items": {"type": "string"}},
        "alternatives": {"type": "array", "maxItems": 3, "items": {
            "type": "object", "properties": {"option": {"type": "string"}, "rejected_because": {"type": "string"}},
            "required": ["option", "rejected_because"]}},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
}
TOOL_DESCRIPTIONS = {
    "Messages___send_email": "Send an email to saved contacts (recipient_contact_ids). One call can address several contacts.",
    "Calendar___list_events": "List calendar events between two ISO datetimes.",
    "Calendar___create_event": "Create a calendar event owned by Butler.",
    "Calendar___update_event": "Change an event. event_owner must be the event's real owner.",
    "Calendar___delete_event": "Delete an event. event_owner must be the event's real owner.",
    "Supplies___search_products": "Search the (simulated) catalogue. deliver_by filters out items that arrive later.",
    "Supplies___checkout": "Buy items from ONE merchant. amount_minor must equal the sum of unit_price_minor x qty.",
    "Supplies___refund": "Refund a whole order by order_id.",
    "Services___search_providers": "Find (simulated) providers for a service type on or before a date.",
    "Services___book_service": "Book a provider's slot. Normally only done after the customer chose via request_decision.",
    "Services___cancel_booking": "Cancel a booking.",
    "Context___get_weather": "Weather forecast for a date.",
}
LOCAL_TOOLS: list[dict[str, Any]] = [
    {"name": "get_household", "description": "Household name, members and contacts (ids, names, tags; no emails).",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "get_plan", "description": "The current plan and its needs with statuses.",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "list_rules", "description": "Active rules as plain text. Enforcement never depends on you reading them.",
     "inputSchema": {"json": {"type": "object", "properties": {}}}},
    {"name": "update_need", "description": "Set a need to done, blocked or skipped with a one-line note.",
     "inputSchema": {"json": {"type": "object", "properties": {
         "need_id": {"type": "string"}, "status": {"type": "string", "enum": ["done", "blocked", "skipped", "doing"]},
         "note": {"type": "string"}}, "required": ["need_id", "status"]}}},
    {"name": "request_decision", "description": "Ask the customer. Sets the need to needs_you.",
     "inputSchema": {"json": {"type": "object", "properties": {
         "need_id": {"type": "string"}, "kind": {"type": "string", "enum": ["choose_option", "approve_action"]},
         "question": {"type": "string", "description": "Spoken-ready, one sentence."},
         "options": {"type": "array", "minItems": 1, "maxItems": 5, "items": {"type": "object", "properties": {
             "title": {"type": "string"}, "subtitle": {"type": "string"},
             "price": {"type": "object", "properties": {"amount_minor": {"type": "integer"}, "currency": {"type": "string"}}},
             "tradeoff": {"type": "string"}, "simulated": {"type": "boolean"},
             "action_draft": {"type": "object", "description": "What runs if chosen.", "properties": {
                 "tool": {"type": "string"}, "args": {"type": "object"}, "summary": {"type": "string"}},
                 "required": ["tool", "args", "summary"]}},
             "required": ["title", "tradeoff"]}},
         "default_index": {"type": "integer"},
         "reason_held": {"type": "object", "properties": {"rule_id": {"type": "string"}, "rule_text": {"type": "string"}}}},
         "required": ["need_id", "kind", "question", "options"]}}},
    {"name": "get_preferences", "description": "Household preferences learned so far (merchants, providers).",
     "inputSchema": {"json": {"type": "object", "properties": {"keys": {"type": "array", "items": {"type": "string"}}}}}},
    {"name": "note_preference", "description": "Remember a preference after a successful purchase or booking.",
     "inputSchema": {"json": {"type": "object", "properties": {
         "key": {"type": "string"}, "value": {"type": "string"}, "evidence": {"type": "string"}},
         "required": ["key", "value", "evidence"]}}},
    {"name": "finish", "description": "End the run when no need is still doing.",
     "inputSchema": {"json": {"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}}},
]


def _inline_refs(node: Any, defs: dict[str, Any]) -> Any:
    if isinstance(node, dict):
        if "$ref" in node:
            return _inline_refs(defs[node["$ref"].split("/")[-1]], defs)
        return {k: _inline_refs(v, defs) for k, v in node.items() if k not in ("$defs", "title")}
    if isinstance(node, list):
        return [_inline_refs(v, defs) for v in node]
    return node


def gateway_tool_specs() -> list[dict[str, Any]]:
    """Converse toolSpecs for the Gateway tools, derived from the contract input models."""
    specs = []
    for name, spec in TOOLS.items():
        schema = spec.model.model_json_schema(by_alias=True)
        body = _inline_refs(schema, schema.get("$defs", {}))
        props = {k: v for k, v in body["properties"].items() if k not in COMMON_FIELDS}
        props["need_id"] = {"type": "string", "description": "The need this action serves."}
        props["reasoning"] = REASONING_SCHEMA
        required = ["need_id", *[r for r in body.get("required", []) if r not in COMMON_FIELDS]]
        specs.append({"name": name, "description": TOOL_DESCRIPTIONS[name],
                      "inputSchema": {"json": {"type": "object", "properties": props, "required": required}}})
    return specs


def all_tool_specs() -> list[dict[str, Any]]:
    return [*LOCAL_TOOLS, *gateway_tool_specs()]


class StrandsPlanner:
    def __init__(self, llm: BedrockLLM, model_id: str | None = None, max_turns: int = MAX_TURNS):
        self.llm, self.model_id, self.max_turns = llm, model_id or planner_model(), max_turns

    def run(self, ctx: RunContext) -> None:
        system, _ = prompts.load("planner")
        messages: list[dict[str, Any]] = [{"role": "user", "content": [{"text": self._brief(ctx)}]}]
        tools = all_tool_specs()
        try:
            for _ in range(self.max_turns):
                ctx.guard.check_time()
                res = self.llm.converse(model_id=self.model_id, system=system, messages=messages, tools=tools, max_tokens=3000)
                messages.append({"role": "assistant", "content": response_blocks(res)})
                uses = response_tool_uses(res)
                if not uses:
                    break
                messages.append({"role": "user", "content": [self._run_tool(ctx, u) for u in uses]})
                if ctx.finished_summary is not None:
                    break
            else:
                log.warning("planner hit the turn limit")
                ctx.finalize(ctx.run_limit_reason())
                return
        except RunLimitExceeded as e:
            log.warning("run limit: %s", e)
            ctx.finalize(ctx.run_limit_reason())
            return
        ctx.finalize("I couldn't finish this one. Ask me to try again.")

    def _brief(self, ctx: RunContext) -> str:
        hh = ctx.store.get_household(ctx.household_id)
        return json.dumps({"task": "Work this plan's needs to a terminal state, then call finish.",
                           "now": ctx.now().isoformat(timespec="minutes"), "timezone": hh.timezone if hh else None,
                           "plan": ctx.get_plan()})

    def _run_tool(self, ctx: RunContext, use: dict[str, Any]) -> dict[str, Any]:
        name, args = use["name"], dict(use.get("input") or {})
        try:
            text = self._execute(ctx, name, args)
            status = "success"
        except RunLimitExceeded:
            raise
        except (ValidationError, ValueError, LookupError, KeyError, TypeError) as e:
            text, status = f"ERROR: {_short(e)}", "error"
        return {"toolResult": {"toolUseId": use["toolUseId"], "content": [{"text": text[:8000]}], "status": status}}

    def _execute(self, ctx: RunContext, name: str, args: dict[str, Any]) -> str:
        if name in TOOLS:
            need_id = args.pop("need_id")
            ctx.need(need_id)  # raises LookupError for ids the model made up
            reasoning = args.pop("reasoning", None)
            return ctx.act(name, args, need_id=need_id, reasoning=reasoning).text
        local = {
            "get_household": lambda: ctx.get_household(), "get_plan": lambda: ctx.get_plan(),
            "list_rules": lambda: ctx.list_rules(),
            "update_need": lambda: ctx.update_need(args["need_id"], args["status"], args.get("note")),
            "request_decision": lambda: _decision_summary(ctx.request_decision(
                args["need_id"], args["kind"], args["question"], args["options"], args.get("default_index"),
                args.get("reason_held"))),
            "get_preferences": lambda: ctx.get_preferences(args.get("keys")),
            "note_preference": lambda: ctx.note_preference(args["key"], args["value"], args["evidence"]).model_dump(),
            "finish": lambda: ctx.finish(args.get("summary", "")),
        }
        if name not in local:
            raise ValueError(f"unknown tool {name}")
        return json.dumps(local[name](), default=str)


def _decision_summary(decision: Any) -> dict[str, Any]:
    return {"decision_id": decision.decision_id, "status": decision.status,
            "options": [o.option_id for o in decision.options]}


def _short(e: Exception) -> str:
    return str(e).replace("\n", " ")[:400]


__all__ = ["Store", "StrandsPlanner", "all_tool_specs", "gateway_tool_specs"]
