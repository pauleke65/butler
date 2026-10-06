"""The golden path through Workstream A's HTTP gateway emulator (real JSON-RPC, real Cedar, real handlers)."""
from functools import partial

import pytest
from agent_support import HH, IDS, NOW, away_plan, build_agent, hosting_plan, needs_by_label, start
from butler_action_handlers import dispatch
from butler_actions.gateway import HttpGatewayClient
from butler_local.gateway import create_app
from starlette.testclient import TestClient


def http_world(world, deny_style):
    app = create_app(world.store, IDS, delay_ms=0, deny_style=deny_style,
                     dispatch=partial(dispatch, now=NOW, adapters=world.adapters))
    tokens = {"butler-agent": lambda: "local-agent-token", "approval-executor": lambda: "local-executor-token"}
    world.gateway = HttpGatewayClient("http://localhost:8090/mcp", tokens, household_id=HH, client=TestClient(app))
    return build_agent(world)


@pytest.mark.parametrize("deny_style", ["jsonrpc_error", "tool_error", "http_403"])
def test_golden_flow_over_http_for_every_denial_shape(store, world, deny_style):
    agent = http_world(world, deny_style)
    hosting = hosting_plan(store)
    assert start(agent, hosting)["ok"]
    done = store.get_plan(HH, hosting.plan_id)
    assert {n.label: n.status for n in done.needs} == {
        "Invite guests": "done", "Add to calendar": "done", "Food and drinks": "done", "Cleaning": "needs_you"}
    assert len(world.adapters.email.sent) == 6 and world.adapters.payments.charges[0]["amount_minor"] == 4200

    rule = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c",
                         "correction": "Don't buy drinks without asking me."})["data"]["rule"]
    assert agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": rule["rule_id"]})["ok"]

    away = away_plan(store)
    assert start(agent, away)["ok"]
    need = needs_by_label(store, away)["Pause or redirect supplies"]
    assert need.status == "needs_you"
    decision = store.get_decision(away.plan_id, need.decision_id)
    assert decision.kind == "approve_action" and decision.reason_held.rule_id == rule["rule_id"]
    held = [r for r in store.list_receipts_for_plan(away.plan_id) if r.action.tool == "Supplies___checkout"]
    assert [r.status for r in held] == ["held_for_approval"] and held[0].authority.matcher_gateway_agree
    assert len(world.adapters.payments.charges) == 1  # nothing was bought for the away plan
