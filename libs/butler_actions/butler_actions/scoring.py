"""might_disagree score (contracts §8.1): deterministic, from the household's receipt history."""
from __future__ import annotations

import statistics
from datetime import datetime
from typing import Any

from butler_contracts.models import Receipt, Rule

from .summaries import READ_ONLY_TOOLS, SERVICE_NOUN

# "First time I did this" only matters where money or other people's time is involved; a first invite email
# or calendar entry is not something a customer would object to.
FIRST_OF_KIND_TOOLS = {"Supplies___checkout", "Services___book_service"}

WEIGHTS = {"first_of_kind": 0.30, "near_cap": 0.25, "above_usual_price": 0.20, "differs_from_past": 0.15,
           "low_confidence": 0.10}


def _kind_key(tool: str, args: dict[str, Any]) -> str | None:
    """Category (checkout) or service_type (book_service) that groups comparable purchases."""
    return args.get("category") or args.get("service_type")


def _same_kind(tool: str, key: str | None, r: Receipt) -> bool:
    return r.action.tool == tool and _kind_key(tool, r.action.args) == key


def _vendor(tool: str, args: dict[str, Any]) -> str | None:
    return args.get("merchant") if tool == "Supplies___checkout" else args.get("provider_id")


def _cap_for(tool: str, rules: list[Rule]) -> int | None:
    caps = [r.params["cap_minor"] for r in rules if r.active and r.template == "spend_cap" and tool in r.params["tools"]]
    return min(caps) if caps else None


def _label(factor: str, tool: str, args: dict[str, Any]) -> str:
    if factor == "first_of_kind":
        if tool == "Services___book_service":
            return f"It's the first time I booked {SERVICE_NOUN.get(str(args.get('service_type')), 'a service')}"
        if tool == "Supplies___checkout":
            return f"It's the first time I bought {args.get('category', 'this')}"
        return "It's the first time I did this"
    return {
        "near_cap": "It's close to your spending limit",
        "above_usual_price": f"It costs more than usual for {args.get('category') or args.get('service_type') or 'this'}",
        "differs_from_past": "I used a different seller than last time",
        "low_confidence": "I wasn't sure about this one",
    }[factor]


def _factors(store: Any, household_id: str, tool: str, args: dict[str, Any], reasoning: dict[str, Any] | None,
             now: datetime) -> dict[str, bool]:
    key = _kind_key(tool, args)
    history = [r for r in store.list_receipts(household_id)
               if r.status == "executed" and datetime.fromisoformat(r.created_at) <= now and _same_kind(tool, key, r)]
    amount = args.get("amount_minor")
    amounts = [r.action.args["amount_minor"] for r in history if isinstance(r.action.args.get("amount_minor"), int)]
    cap = _cap_for(tool, store.list_rules(household_id, active_only=True)) if isinstance(amount, int) else None
    vendor = _vendor(tool, args)
    recent_vendors = [_vendor(tool, r.action.args) for r in history[:2]]  # newest first
    conf = (reasoning or {}).get("confidence")
    return {
        "first_of_kind": tool in FIRST_OF_KIND_TOOLS and not history,
        "near_cap": cap is not None and amount >= 0.8 * cap,
        "above_usual_price": bool(amounts) and isinstance(amount, int) and amount >= 1.2 * statistics.median(amounts),
        "differs_from_past": bool(history) and vendor is not None and vendor not in recent_vendors,
        "low_confidence": isinstance(conf, (int, float)) and conf < 0.6,
    }


def might_disagree(store: Any, household_id: str, tool: str, args: dict[str, Any], reasoning: dict[str, Any] | None,
                   now: datetime) -> dict[str, Any]:
    """``{"score": 0..1, "top_reason": str | None}``; read-only tools always score 0."""
    if tool in READ_ONLY_TOOLS:
        return {"score": 0.0, "top_reason": None}
    hit = [f for f, on in _factors(store, household_id, tool, args, reasoning, now).items() if on]
    if not hit:
        return {"score": 0.0, "top_reason": None}
    score = round(sum(WEIGHTS[f] for f in hit), 2)
    top = max(hit, key=lambda f: WEIGHTS[f])
    return {"score": score, "top_reason": _label(top, tool, args)}
