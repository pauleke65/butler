"""Test helpers for the agent (the world itself lives in ``butler_agent.sandbox``)."""
from __future__ import annotations

from typing import Any

from butler_actions.store import Store
from butler_agent.sandbox import HH, IDS, NOW, World, make_plan, seed_world
from butler_contracts.models import Need, Plan

__all__ = ["HH", "IDS", "NOW", "World", "make_plan", "seed_world"]


# ── helpers shared by several test modules ─────────────────────────────
def build_agent(world: World, **kw: Any):
    from butler_agent.agent import Agent, Services
    from butler_agent.drafter import PatternRuleDrafter
    from butler_agent.planner.scripted import ScriptedPlanner
    from butler_rules import LocalPolicyService

    services = Services(store=world.store, gateway=world.gateway, planner=kw.pop("planner", ScriptedPlanner()),
                        drafter=PatternRuleDrafter(), policy=LocalPolicyService(world.store, ids=IDS), ids=IDS, **kw)
    return Agent(services)


def start(agent: Any, plan: Plan, correlation_id: str = "cor_test") -> dict[str, Any]:
    return agent.handle({"op": "start_plan", "household_id": HH, "correlation_id": correlation_id, "plan_id": plan.plan_id})


def hosting_plan(store: Store) -> Plan:
    return make_plan(store, "Tell Butler six friends from the dinner crew are coming over Friday at 7.", "hosting",
                     "Dinner for 6, Friday 7 PM", "2026-10-16T19:00:00-04:00", "2026-10-16T22:00:00-04:00")


def away_plan(store: Store) -> Plan:
    return make_plan(store, "I'm travelling Thursday to Sunday. My parents are staying at the house.", "away",
                     "Away Thursday to Sunday", "2026-10-15T09:00:00-04:00", "2026-10-18T18:00:00-04:00")


def needs_by_label(store: Store, plan: Plan) -> dict[str, Need]:
    return {n.label: n for n in store.get_plan(HH, plan.plan_id).needs}
