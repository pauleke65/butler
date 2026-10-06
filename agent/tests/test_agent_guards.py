"""Run limits (contracts §5.1 rule 5) and the retry-after-deny guard (rule 2)."""
import pytest
from agent_support import HH, hosting_plan, make_plan, needs_by_label
from butler_agent.context import ActResult
from butler_agent.guard import RunGuard, RunLimitExceeded
from butler_agent.planner.scripted import ScriptedPlanner


def test_step_cap_raises_on_the_26th_call():
    g = RunGuard()
    for _ in range(25):
        g.before_call()
    with pytest.raises(RunLimitExceeded):
        g.before_call()


def test_wall_clock_cap():
    t = {"now": 0.0}
    g = RunGuard(monotonic=lambda: t["now"])
    g.before_call()
    t["now"] = 120.5
    with pytest.raises(RunLimitExceeded, match="wall clock"):
        g.before_call()


def test_hitting_the_cap_blocks_remaining_needs_with_a_retry_note(store, world):
    plan = hosting_plan(store)
    ctx = world.context(plan, guard=RunGuard(max_steps=3))
    ScriptedPlanner().run(ctx)
    done = store.get_plan(HH, plan.plan_id)
    assert not [n for n in done.needs if n.status == "doing"]
    blocked = [n for n in done.needs if n.status == "blocked"]
    assert blocked and all(n.note == "Ran out of time; ask me to try again." for n in blocked)
    assert ctx.guard.steps == 3


def test_time_cap_blocks_remaining_needs(store, world):
    plan = hosting_plan(store)
    clock = {"t": 0.0}

    def tick():
        clock["t"] += 50.0  # each guard check burns 50 s
        return clock["t"]

    ctx = world.context(plan, guard=RunGuard(monotonic=tick))
    ScriptedPlanner().run(ctx)
    statuses = {n.status for n in store.get_plan(HH, plan.plan_id).needs}
    assert "doing" not in statuses and "blocked" in statuses


def test_a_denied_action_cannot_be_retried_for_the_same_need(store, world):
    from butler_actions.store import Store  # noqa: F401

    plan = make_plan(store, "x", "running_low", "x", needs=[("A", "supplies"), ("B", "supplies")])
    need, other_need = plan.needs
    ctx = world.context(plan)
    args = {"merchant": "FreshCart", "items": [{"sku": "drk-wine-3", "qty": 1}], "amount_minor": 5200, "currency": "USD",
            "category": "drinks"}
    first = ctx.act("Supplies___checkout", args, need_id=need.need_id)
    assert first.kind == "ask" and first.denied_rule["rule_id"] == "rule_default_spend"
    # "dodging" the rule with a cheaper-looking variant of the same tool is blocked without calling the gateway
    calls_before = len(world.gateway.calls)
    second = ctx.act("Supplies___checkout", {**args, "items": [{"sku": "drk-wine-3", "qty": 1}], "amount_minor": 5200},
                     need_id=need.need_id)
    assert second.kind == "retry_blocked" and "DENIED_RETRY_BLOCKED" in second.text
    assert len(world.gateway.calls) == calls_before
    # a different need is unaffected
    other = ctx.act("Supplies___checkout", {**args, "items": [{"sku": "drk-tea", "qty": 1}], "amount_minor": 1300},
                    need_id=other_need.need_id)
    assert other.kind == "executed"
    with pytest.raises(LookupError):
        ctx.act("Supplies___checkout", args, need_id="need_made_up")


def test_act_result_kinds(store, world):
    plan = make_plan(store, "x", "running_low", "x")
    ctx = world.context(plan)
    bad = ctx.act("Supplies___checkout", {"merchant": "FreshCart", "items": [{"sku": "drk-tea", "qty": 1}],
                                          "amount_minor": 1, "currency": "USD", "category": "drinks"},
                  need_id=plan.needs[0].need_id)
    assert isinstance(bad, ActResult) and bad.kind == "failed" and "INVALID_INPUT" in bad.text
    assert needs_by_label(store, plan)["Check and reorder supplies"].action_ids  # receipts are linked to the need
