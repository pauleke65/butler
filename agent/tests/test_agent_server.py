"""HTTP surface: POST /invocations (async ack for plan ops, data for sync ops) and GET /ping."""
import threading

from agent_support import HH, build_agent, hosting_plan
from butler_agent.planner.scripted import ScriptedPlanner
from butler_agent.server import create_app
from starlette.testclient import TestClient

BASE = {"household_id": HH, "correlation_id": "cor_http"}


def test_ping_reports_healthy_then_busy_while_a_plan_runs(store, world):
    started, release = threading.Event(), threading.Event()

    class Slow:
        def run(self, ctx):
            started.set()
            release.wait(5)
            ScriptedPlanner().run(ctx)

    agent = build_agent(world, planner=Slow())
    client = TestClient(create_app(agent))
    assert client.get("/ping").json()["status"] == "Healthy"
    plan = hosting_plan(store)
    res = client.post("/invocations", json={"op": "start_plan", **BASE, "plan_id": plan.plan_id})
    assert res.status_code == 200 and res.json() == {"ok": True, "data": {"accepted": True}}  # returned while work continues
    assert started.wait(2)
    ping = client.get("/ping").json()
    assert ping["status"] == "HealthyBusy" and isinstance(ping["time_of_last_update"], int)
    release.set()
    assert agent.runner.wait_idle(20)
    assert client.get("/ping").json()["status"] == "Healthy"
    assert store.get_plan(HH, plan.plan_id).status == "waiting_on_you"


def test_sync_ops_return_their_data(store, world):
    client = TestClient(create_app(build_agent(world)))
    drafted = client.post("/invocations", json={"op": "draft_rule", **BASE, "correction": "Don't buy drinks without asking me."}).json()
    assert drafted["ok"] and drafted["data"]["draft"]["template"] == "ask_category"
    rule_id = drafted["data"]["rule"]["rule_id"]
    applied = client.post("/invocations", json={"op": "apply_rule", **BASE, "rule_id": rule_id}).json()
    assert applied["data"]["rule"]["policy_status"] == "active"
    removed = client.post("/invocations", json={"op": "remove_rule", **BASE, "rule_id": rule_id}).json()
    assert removed["data"]["rule"]["active"] is False


def test_errors_use_the_envelope(world):
    client = TestClient(create_app(build_agent(world)))
    assert client.post("/invocations", content=b"not json").status_code == 400
    assert client.post("/invocations", json=[1]).status_code == 400
    bad = client.post("/invocations", json={"op": "draft_rule", **BASE}).json()
    assert bad["ok"] is False and bad["error"]["code"] == "INVALID_INPUT"
    unsupported = client.post("/invocations", json={"op": "draft_rule", **BASE, "correction": "stop ordering pizza"}).json()
    assert unsupported["error"]["code"] == "RULE_UNSUPPORTED"
    assert client.post("/invocations", json={"op": "start_plan", **BASE, "plan_id": "plan_x"}).json()["error"]["code"] == "NOT_FOUND"
