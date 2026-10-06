"""Test doubles: an in-process Gateway that evaluates the real compiled Cedar (shared with other workstreams)."""
from __future__ import annotations

import itertools
from collections.abc import Callable
from typing import Any

from butler_contracts.models import Rule
from butler_rules import CedarEvaluator, Identities, PrincipalName

from .gateway import GatewayResponse

Handler = Callable[[str, dict[str, Any]], dict[str, Any]]


def stub_handler(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    """Plausible handler results per tool (``{"ok": True, "data": ...}``)."""
    n = next(_counter)
    data: dict[str, Any] = {
        "Supplies___checkout": {"order_id": f"ord_{n}", "payment_ref": f"pay_{n}", "amount_minor": args.get("amount_minor"),
                                "eta": "Friday", "simulated_merchant": True, "payment_mode": "test"},
        "Supplies___refund": {"refund_ref": f"ref_{n}", "amount_minor": 0},
        "Services___book_service": {"booking_id": f"bkg_{n}", "confirmation_code": "ABC123", "simulated": True},
        "Services___cancel_booking": {"cancelled": True},
        "Messages___send_email": {"message_ids": [f"m{n}"], "sent_to": args.get("recipient_contact_ids") or ["x@example.com"]},
        "Calendar___create_event": {"event_id": f"evt_{n}", "html_link": "https://calendar.example/e"},
        "Calendar___update_event": {"event_id": args.get("event_id")},
        "Calendar___delete_event": {"deleted": True},
        "Calendar___list_events": {"events": []},
        "Supplies___search_products": {"products": []},
        "Services___search_providers": {"providers": []},
        "Context___get_weather": {"summary": "Sunny", "high_c": 20, "low_c": 10, "precip_prob": 0},
    }.get(tool, {})
    return {"ok": True, "data": data}


_counter = itertools.count(1)


class CedarFakeGateway:
    """GatewayClient that denies via real Cedar over the household's active rules and records every call."""

    def __init__(self, store: Any, ids: Identities | None = None, handler: Handler = stub_handler,
                 rules: list[Rule] | None = None):
        self.store, self.ids, self.handler, self.rules = store, ids or Identities.local(), handler, rules
        self.calls: list[tuple[PrincipalName, str, dict[str, Any]]] = []
        self.force_decision: str | None = None  # simulate a matcher/gateway disagreement

    def call(self, principal: PrincipalName, tool: str, args: dict[str, Any], *,
             household_id: str = "hh_demo") -> GatewayResponse:
        rules = self.rules if self.rules is not None else self.store.list_rules(household_id, active_only=True)
        decision, _ = CedarEvaluator(rules, self.ids).authorize(principal, tool, args)
        decision = self.force_decision or decision
        if decision == "DENY":
            return GatewayResponse("denied", None, {"code": "POLICY_DENIED", "message": "denied by policy"}, "req-fake")
        self.calls.append((principal, tool, args))
        res = self.handler(tool, args)
        if res.get("ok"):
            return GatewayResponse("ok", res.get("data") or {}, None, "req-fake")
        return GatewayResponse("error", None, res.get("error") or {"code": "INTERNAL", "message": "error"}, "req-fake")
