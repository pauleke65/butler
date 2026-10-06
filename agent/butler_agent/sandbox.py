"""An in-process Butler world for tests and evals: seeded store, fake adapters, and a gateway that runs the
real compiled Cedar and then the real action handlers (no HTTP, no AWS)."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from butler_action_handlers import dispatch, fake_adapters
from butler_action_handlers.seeddata import seed_dir
from butler_actions import clock
from butler_actions.ids import new_id
from butler_actions.store import Store
from butler_actions.testing import CedarFakeGateway
from butler_contracts.models import Contact, Household, Need, Plan, Receipt
from butler_rules import Identities, default_rules

from .context import RunContext

NY = ZoneInfo("America/New_York")
NOW = datetime(2026, 10, 12, 10, 0, tzinfo=NY)  # Monday; "Friday" = 16 Oct, "Thursday" = 15 Oct
HH = "hh_demo"
IDS = Identities.local()

# Keyword-fallback needs (contracts §12.1), what the server creates when the fast needs pass is unavailable.
FALLBACK_NEEDS: dict[str, list[tuple[str, str]]] = {
    "hosting": [("Invite guests", "messages"), ("Add to calendar", "calendar"), ("Food and drinks", "supplies"),
                ("Cleaning", "services")],
    "away": [("Tell people", "messages"), ("Block calendar", "calendar"), ("Pause or redirect supplies", "supplies")],
    "running_low": [("Check and reorder supplies", "supplies")],
}


def seed_world(store: Store, *, history: bool = True, now: datetime = NOW) -> None:
    data = json.loads((seed_dir() / "household.json").read_text())
    store.put_household(Household(**data["household"]))
    for m in data["members"]:
        store.put_member(HH, m)
    for c in json.loads((seed_dir() / "contacts.json").read_text()):
        store.put_contact(HH, Contact(**c))
    for rule in default_rules(HH, IDS, now.isoformat(timespec="seconds")):
        store.put_rule(rule.model_copy(update={"active": True, "policy_status": "active"}))
    if history:
        seed_history(store, now)


def seed_history(store: Store, now: datetime = NOW) -> None:
    for h in json.loads((seed_dir() / "history.json").read_text())["receipts"]:
        when = now - timedelta(days=h["days_ago"])
        created = when.isoformat(timespec="seconds")
        args = {"merchant": h["merchant"], "items": h["items"], "amount_minor": h["amount_minor"], "currency": "USD",
                "category": h["category"]}
        store.put_receipt(Receipt(
            action_id=new_id("act", int(when.timestamp() * 1000)), household_id=HH, correlation_id="cor_seed",
            action={"tool": h["tool"], "args": args}, title=h["title"], status="executed",
            reasons=[], context_used=[], alternatives=[],
            authority={"decision": "ALLOW", "principal": "butler-agent", "rule_ids": [], "rule_texts": [],
                       "evaluated_at": created, "matcher_gateway_agree": True},
            cost={"amount_minor": h["amount_minor"], "currency": "USD"}, reversible=True,
            might_disagree={"score": 0.0}, simulated=True, spoken_summary="Seed.", created_at=created))


def make_plan(store: Store, situation: str, kind: str, title: str, starts_at: str | None = None,
              ends_at: str | None = None, needs: list[tuple[str, str]] | None = None) -> Plan:
    plan_id, iso = new_id("plan"), clock.iso()
    plan = Plan(plan_id=plan_id, household_id=HH, situation=situation, kind=kind, title=title,  # type: ignore[arg-type]
                starts_at=starts_at, ends_at=ends_at, status="active", created_at=iso, updated_at=iso, needs=[
                    Need(need_id=new_id("need"), plan_id=plan_id, label=label, capability=cap,  # type: ignore[arg-type]
                         status="doing", action_ids=[], updated_at=iso)
                    for label, cap in (needs or FALLBACK_NEEDS.get(kind, []))])
    store.put_plan(plan)
    return plan


class World:
    """Store + fake adapters + a Cedar-enforcing in-process gateway over the real handlers."""

    def __init__(self, store: Store, now: datetime = NOW):
        self.store, self.now, self.adapters = store, now, fake_adapters()
        clock.set_now(now)
        self.gateway = CedarFakeGateway(store, IDS, handler=self._handle)

    def _handle(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        return dispatch(tool, args, store=self.store, now=self.now, adapters=self.adapters, household_id=HH)

    def context(self, plan: Plan, **kw: Any) -> RunContext:
        return RunContext(HH, plan.plan_id, "cor_test", self.store, self.gateway, ids=IDS, **kw)

    def close(self) -> None:
        clock.set_now(None)
