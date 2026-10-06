"""Rule templates (contracts §9.3): param validation, text, Cedar clauses and Python matching.

Each template describes *what it covers* three ways that must agree: the Cedar scope/conditions
(``cedar_conditions``), the Python matcher (``fires``) and the human text. The parity tests keep the
Cedar and Python sides in sync.
"""
from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, get_args

from butler_contracts.models import ActionDraft, CheckoutInput

TemplateId = Literal[
    "spend_cap", "ask_category", "ask_tool", "ask_non_contact", "never_contact",
    "protect_human_events", "never_tool",
]
RuleEffect = Literal["allow", "ask_first", "never"]

GATEWAY_TOOLS: tuple[str, ...] = get_args(ActionDraft.model_fields["tool"].annotation)
PRODUCT_CATEGORIES: tuple[str, ...] = get_args(CheckoutInput.model_fields["category"].annotation)
SPEND_TOOLS: tuple[str, ...] = ("Supplies___checkout", "Services___book_service")
MAX_CAP_MINOR = 100_000_000
_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

AGENT_ONLY = 'principal.hasTag("sub") && principal.getTag("sub") == "{agent_sub}"'


class RuleParamError(ValueError):
    """Template params failed validation."""


# ── helpers ───────────────────────────────────────────────────────────────
def is_int(v: Any) -> bool:
    """True for real ints only (bool is not a Cedar Long)."""
    return type(v) is int


def cedar_str(s: str) -> str:
    """Quote a string for Cedar. Inputs are pre-validated; this is belt and braces."""
    if any(ord(c) < 32 for c in s):
        raise RuleParamError("control characters are not allowed")
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def action_ref(tool: str) -> str:
    return f"AgentCore::Action::{cedar_str(tool)}"


def dollars(amount_minor: int) -> str:
    """Spoken money: 5000 -> '50 dollars', 4250 -> '42 dollars 50'."""
    d, c = divmod(amount_minor, 100)
    unit = "dollar" if d == 1 and c == 0 else "dollars"
    return f"{d} {unit}" if c == 0 else f"{d} dollars {c}"


GERUND = {
    "Supplies___checkout": "buying anything", "Supplies___refund": "refunding anything",
    "Supplies___search_products": "searching for products", "Services___book_service": "booking a service",
    "Services___cancel_booking": "cancelling bookings", "Services___search_providers": "searching for providers",
    "Messages___send_email": "sending email", "Calendar___create_event": "creating calendar events",
    "Calendar___update_event": "changing calendar events", "Calendar___delete_event": "deleting calendar events",
    "Calendar___list_events": "reading my calendar", "Context___get_weather": "checking the weather",
}
VERB = {
    "Supplies___checkout": "buy anything", "Supplies___refund": "refund anything",
    "Supplies___search_products": "search for products", "Services___book_service": "book a service",
    "Services___cancel_booking": "cancel bookings", "Services___search_providers": "search for providers",
    "Messages___send_email": "send email", "Calendar___create_event": "create calendar events",
    "Calendar___update_event": "change calendar events", "Calendar___delete_event": "delete calendar events",
    "Calendar___list_events": "read my calendar", "Context___get_weather": "check the weather",
}
CATEGORY_PHRASE = {
    "groceries": "groceries", "drinks": "drinks", "household": "household supplies", "toiletries": "toiletries",
    "gifts": "gifts", "other": "other things",
}


# ── validation ────────────────────────────────────────────────────────────
def _no_params(params: dict[str, Any]) -> None:
    if params:
        raise RuleParamError(f"this template takes no params, got {sorted(params)}")


def _only(params: dict[str, Any], allowed: set[str]) -> None:
    extra = set(params) - allowed
    if extra:
        raise RuleParamError(f"unknown params: {sorted(extra)}")


def _tool(params: dict[str, Any]) -> str:
    tool = params.get("tool")
    if tool not in GATEWAY_TOOLS:
        raise RuleParamError(f"tool must be one of the gateway tools, got {tool!r}")
    return tool


def _v_spend_cap(p: dict[str, Any]) -> None:
    _only(p, {"tools", "cap_minor"})
    tools = p.get("tools")
    if not isinstance(tools, list) or not tools or any(t not in SPEND_TOOLS for t in tools):
        raise RuleParamError(f"tools must be a non-empty subset of {list(SPEND_TOOLS)}")
    if len(set(tools)) != len(tools):
        raise RuleParamError("tools must not repeat")
    cap = p.get("cap_minor")
    if not is_int(cap) or not 0 <= cap <= MAX_CAP_MINOR:
        raise RuleParamError("cap_minor must be an integer number of cents, 0 or more")


def _v_category(p: dict[str, Any]) -> None:
    _only(p, {"category"})
    if p.get("category") not in PRODUCT_CATEGORIES:
        raise RuleParamError(f"category must be one of {list(PRODUCT_CATEGORIES)}")


def _v_tool(p: dict[str, Any]) -> None:
    _only(p, {"tool"})
    _tool(p)


def _v_contact(p: dict[str, Any]) -> None:
    _only(p, {"contact_id", "contact_name"})
    cid = p.get("contact_id")
    if not isinstance(cid, str) or not _ID_RE.match(cid):
        raise RuleParamError("contact_id must be a simple id string")
    name = p.get("contact_name")
    if name is not None and (not isinstance(name, str) or len(name) > 60):
        raise RuleParamError("contact_name must be a short string")


# ── texts ─────────────────────────────────────────────────────────────────
def _t_spend_cap(p: dict[str, Any]) -> str:
    cap = dollars(p["cap_minor"])
    tools = tuple(p["tools"])
    if tools == ("Supplies___checkout",):
        return f"Ask me before buying anything over {cap}."
    if tools == ("Services___book_service",):
        return f"Ask me before booking a service over {cap}."
    return f"Ask me before spending more than {cap}."


def _t_category(p: dict[str, Any]) -> str:
    return f"Ask me before buying {CATEGORY_PHRASE[p['category']]}."


def _t_ask_tool(p: dict[str, Any]) -> str:
    return f"Ask me before {GERUND[p['tool']]}."


def _t_contact(p: dict[str, Any]) -> str:
    return f"Never message {p.get('contact_name') or 'that contact'}."


def _t_never_tool(p: dict[str, Any]) -> str:
    return f"Never {VERB[p['tool']]}."


# ── scope + Cedar conditions ──────────────────────────────────────────────
def _guard(field: str, expr: str | None = None) -> str:
    base = f"context has input && context.input has {field}"
    return f"{base} && {expr}" if expr else base


def _c_spend_cap(p: dict[str, Any]) -> list[str]:
    return [_guard("amount_minor", f"context.input.amount_minor > {p['cap_minor']}")]


def _c_category(p: dict[str, Any]) -> list[str]:
    return [_guard("category", f"context.input.category == {cedar_str(p['category'])}")]


def _c_non_contact(_: dict[str, Any]) -> list[str]:
    return [_guard("recipient_email")]


def _c_never_contact(p: dict[str, Any]) -> list[str]:
    return [_guard("recipient_contact_ids", f"context.input.recipient_contact_ids.contains({cedar_str(p['contact_id'])})")]


def _c_human_events(_: dict[str, Any]) -> list[str]:
    return [_guard("event_owner", 'context.input.event_owner == "human"')]


def _no_conditions(_: dict[str, Any]) -> list[str]:
    return []


# ── Python matching (mirrors the Cedar conditions) ────────────────────────
def _f_spend_cap(p: dict[str, Any], i: dict[str, Any]) -> bool:
    amt = i.get("amount_minor")
    return is_int(amt) and amt > p["cap_minor"]


def _f_category(p: dict[str, Any], i: dict[str, Any]) -> bool:
    return i.get("category") == p["category"]


def _f_non_contact(_: dict[str, Any], i: dict[str, Any]) -> bool:
    return "recipient_email" in i


def _f_never_contact(p: dict[str, Any], i: dict[str, Any]) -> bool:
    ids = i.get("recipient_contact_ids")
    return isinstance(ids, list) and p["contact_id"] in ids


def _f_human_events(_: dict[str, Any], i: dict[str, Any]) -> bool:
    return i.get("event_owner") == "human"


def _always(_: dict[str, Any], __: dict[str, Any]) -> bool:
    return True


@dataclass(frozen=True)
class TemplateSpec:
    """One rule template: validation, wording, Cedar clauses and the Python matcher."""

    template: TemplateId
    effect: RuleEffect
    agent_only: bool
    validate: Callable[[dict[str, Any]], None]
    text: Callable[[dict[str, Any]], str]
    scope: Callable[[dict[str, Any]], tuple[str, ...]]
    cedar_conditions: Callable[[dict[str, Any]], list[str]]
    fires: Callable[[dict[str, Any], dict[str, Any]], bool]


TEMPLATES: dict[TemplateId, TemplateSpec] = {
    "spend_cap": TemplateSpec("spend_cap", "ask_first", True, _v_spend_cap, _t_spend_cap,
                              lambda p: tuple(p["tools"]), _c_spend_cap, _f_spend_cap),
    "ask_category": TemplateSpec("ask_category", "ask_first", True, _v_category, _t_category,
                                 lambda p: ("Supplies___checkout",), _c_category, _f_category),
    "ask_tool": TemplateSpec("ask_tool", "ask_first", True, _v_tool, _t_ask_tool,
                             lambda p: (p["tool"],), _no_conditions, _always),
    "ask_non_contact": TemplateSpec("ask_non_contact", "ask_first", True, lambda p: _no_params(p),
                                    lambda p: "Ask me before messaging anyone who isn't a saved contact.",
                                    lambda p: ("Messages___send_email",), _c_non_contact, _f_non_contact),
    "never_contact": TemplateSpec("never_contact", "never", False, _v_contact, _t_contact,
                                  lambda p: ("Messages___send_email",), _c_never_contact, _f_never_contact),
    "protect_human_events": TemplateSpec(
        "protect_human_events", "never", False, lambda p: _no_params(p),
        lambda p: "Never change or delete events I created.",
        lambda p: ("Calendar___update_event", "Calendar___delete_event"), _c_human_events, _f_human_events),
    "never_tool": TemplateSpec("never_tool", "never", False, _v_tool, _t_never_tool,
                               lambda p: (p["tool"],), _no_conditions, _always),
}


def validate_params(template: str, params: dict[str, Any]) -> None:
    """Raise ``RuleParamError`` unless ``params`` are valid for ``template``."""
    spec = TEMPLATES.get(template)  # type: ignore[call-overload]
    if spec is None:
        raise RuleParamError(f"unknown template {template!r}")
    if not isinstance(params, dict):
        raise RuleParamError("params must be an object")
    spec.validate(params)
