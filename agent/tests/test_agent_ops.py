"""Ops router (contracts §5): envelope, validation, rule lifecycle, async acceptance."""
import threading

from agent_support import HH, IDS, build_agent, hosting_plan, needs_by_label
from butler_agent.drafter import PatternRuleDrafter
from butler_agent.planner.scripted import ScriptedPlanner
from butler_rules import PolicyError, PolicyPropagatingError

BASE = {"household_id": HH, "correlation_id": "cor_ops"}


def op(agent, name, **kw):
    return agent.handle({"op": name, **BASE, **kw})


def test_unknown_op_and_invalid_input(world):
    agent = build_agent(world)
    assert agent.handle({"op": "nope"})["error"]["code"] == "INVALID_INPUT"
    bad = agent.handle({"op": "draft_rule", "household_id": HH})
    assert bad["ok"] is False and bad["error"]["code"] == "INVALID_INPUT" and "correlation_id" in bad["error"]["message"]


def test_start_plan_unknown_plan(world):
    assert op(build_agent(world), "start_plan", plan_id="plan_nope")["error"]["code"] == "NOT_FOUND"


def test_async_ops_return_before_the_work_finishes(store, world):
    started, release = threading.Event(), threading.Event()

    class Slow:
        def run(self, ctx):
            started.set()
            release.wait(5)
            ScriptedPlanner().run(ctx)

    agent = build_agent(world, planner=Slow())
    plan = hosting_plan(store)
    resp = agent.handle({"op": "start_plan", **BASE, "plan_id": plan.plan_id}, run_async=True)
    assert resp == {"ok": True, "data": {"accepted": True}}
    assert started.wait(2) and agent.runner.busy
    assert store.get_plan(HH, plan.plan_id).status == "active"  # still working
    release.set()
    assert agent.runner.wait_idle(20)
    assert store.get_plan(HH, plan.plan_id).status == "waiting_on_you"


def test_a_crashing_planner_never_leaves_needs_doing(store, world):
    class Boom:
        def run(self, ctx):
            raise RuntimeError("model fell over")

    plan = hosting_plan(store)
    assert op(build_agent(world, planner=Boom()), "start_plan", plan_id=plan.plan_id)["ok"]
    done = store.get_plan(HH, plan.plan_id)
    assert {n.status for n in done.needs} == {"blocked"} and done.status == "active"
    assert all("try again" in (n.note or "") for n in done.needs)


def test_resume_skips_already_terminal_needs_and_settles_decisions(store, world):
    agent = build_agent(world)
    plan = hosting_plan(store)
    op(agent, "start_plan", plan_id=plan.plan_id)
    need = needs_by_label(store, plan)["Cleaning"]
    dec = store.get_decision(plan.plan_id, need.decision_id)
    store.transition_decision(HH, plan.plan_id, dec.decision_id, "pending", "rejected")
    assert op(agent, "resume_plan", plan_id=plan.plan_id, decision_id=dec.decision_id)["ok"]
    assert needs_by_label(store, plan)["Cleaning"].status == "skipped"
    assert store.get_plan(HH, plan.plan_id).status == "complete"
    assert len(world.adapters.email.sent) == 6  # nothing was redone


# ── rule lifecycle ───────────────────────────────────────────────────────
def test_draft_rule_stores_a_draft_and_the_latest_pointer(store, world):
    agent = build_agent(world)
    res = op(agent, "draft_rule", correction="Don't buy drinks without asking me.")
    assert res["ok"]
    rule, draft = res["data"]["rule"], res["data"]["draft"]
    assert draft["template"] == "ask_category" and draft["confidence"] >= 0.6
    assert rule["policy_status"] == "draft" and rule["active"] is False and rule["effect"] == "ask_first"
    assert "forbid" in rule["cedar_statement"] and f'@id("{rule["rule_id"]}")' in rule["cedar_statement"]
    stored = store.get_rule(HH, rule["rule_id"])
    assert stored.origin.type == "correction" and stored.origin.utterance == "Don't buy drinks without asking me."
    assert store.get_latest_draft(HH) == rule["rule_id"]


def test_draft_rule_never_contact_resolves_the_boss(store, world):
    res = op(build_agent(world), "draft_rule", correction="Never email my boss.")
    assert res["data"]["rule"]["params"] == {"contact_id": "c_jordan", "contact_name": "Jordan"}
    assert res["data"]["rule"]["effect"] == "never" and res["data"]["rule"]["text"] == "Never message Jordan."


def test_unsupported_corrections_are_rejected_with_the_supported_list(store, world):
    for text in ("Stop ordering pizza.", "What's the weather like?", "Never email my parents."):
        res = op(build_agent(world), "draft_rule", correction=text)
        assert res["ok"] is False and res["error"]["code"] == "RULE_UNSUPPORTED"
        assert "spending limits" in res["error"]["message"]
    assert store.list_rules(HH) and all(r.rule_id.startswith("rule_default") for r in store.list_rules(HH))


def test_low_confidence_is_unsupported(store, world):
    class Unsure(PatternRuleDrafter):
        def draft(self, correction, ctx):
            d = super().draft(correction, ctx)
            return d.model_copy(update={"confidence": 0.59})

    agent = build_agent(world)
    agent.s.drafter = Unsure()
    assert op(agent, "draft_rule", correction="Don't buy drinks without asking me.")["error"]["code"] == "RULE_UNSUPPORTED"


def test_apply_rule_activates_and_is_idempotent(store, world):
    agent = build_agent(world)
    rule_id = op(agent, "draft_rule", correction="Ask me before spending over $30.")["data"]["rule"]["rule_id"]
    first = op(agent, "apply_rule", rule_id=rule_id)
    assert first["ok"] and first["data"]["rule"]["policy_status"] == "active" and first["data"]["rule"]["active"] is True
    assert store.get_rule(HH, rule_id) in store.list_rules(HH, active_only=True)
    assert op(agent, "apply_rule", rule_id=rule_id)["ok"]
    assert op(agent, "apply_rule", rule_id="rule_missing")["error"]["code"] == "NOT_FOUND"


def test_changing_a_limit_creates_the_new_policy_then_disables_the_old(store, world):
    agent = build_agent(world)
    order: list[str] = []
    real = agent.s.policy

    class Spy:
        def create(self, rule):
            order.append(f"create:{rule.rule_id}")
            return real.create(rule)

        def disable(self, rule):
            order.append(f"disable:{rule.rule_id}")
            return real.disable(rule)

    agent.s.policy = Spy()
    draft = op(agent, "draft_rule", correction="Raise my limit to $100.", base_rule_id="rule_default_spend")
    new_id = draft["data"]["rule"]["rule_id"]
    assert draft["data"]["rule"]["params"]["cap_minor"] == 10000
    assert op(agent, "apply_rule", rule_id=new_id)["ok"]
    assert order == [f"create:{new_id}", "disable:rule_default_spend"]
    assert store.get_rule(HH, "rule_default_spend").active is False
    assert store.get_rule(HH, new_id).active is True
    assert [r.rule_id for r in store.list_rules(HH, active_only=True) if r.template == "spend_cap"] == [new_id]


def test_policy_propagating_and_failure_paths(store, world):
    agent = build_agent(world)
    rule_id = op(agent, "draft_rule", correction="Don't message strangers.")["data"]["rule"]["rule_id"]
    rule = store.get_rule(HH, rule_id)

    class Slow:
        def create(self, r):
            raise PolicyPropagatingError(r.model_copy(update={"policy_status": "creating", "policy_id": "p-1"}))

        def disable(self, r):
            raise AssertionError("must not disable while propagating")

    agent.s.policy = Slow()
    res = op(agent, "apply_rule", rule_id=rule_id)
    assert res["ok"] is False and res["error"]["code"] == "POLICY_PROPAGATING"
    assert res["data"]["rule"]["policy_status"] == "creating"
    assert store.get_rule(HH, rule_id).policy_status == "creating" and not store.get_rule(HH, rule_id).active

    class Broken:
        def create(self, r):
            raise PolicyError("CREATE_FAILED: bad cedar")

    agent.s.policy = Broken()
    store.put_rule(rule)
    failed = op(agent, "apply_rule", rule_id=rule_id)
    assert failed["error"]["code"] == "INTERNAL" and store.get_rule(HH, rule_id).policy_status == "failed"
    assert IDS.agent_sub  # keep the shared identities import used


def test_remove_rule_disables(store, world):
    agent = build_agent(world)
    res = op(agent, "remove_rule", rule_id="rule_default_refunds")
    assert res["ok"] and res["data"]["rule"]["active"] is False and res["data"]["rule"]["policy_status"] == "disabled"
    assert "rule_default_refunds" not in {r.rule_id for r in store.list_rules(HH, active_only=True)}
    assert op(agent, "remove_rule", rule_id="rule_missing")["error"]["code"] == "NOT_FOUND"


def test_after_removal_the_agent_is_no_longer_held_back(store, world):
    agent = build_agent(world)
    rule_id = op(agent, "draft_rule", correction="Never email Mum.")["data"]["rule"]["rule_id"]
    op(agent, "apply_rule", rule_id=rule_id)
    op(agent, "remove_rule", rule_id=rule_id)
    from agent_support import away_plan

    plan = away_plan(store)
    op(agent, "start_plan", plan_id=plan.plan_id)
    assert needs_by_label(store, plan)["Tell people"].status == "done"
