"""apply_rule must not report a rule as in force until the gateway enforces it (found in the first
full-stack run: the next purchase slipped through the propagation window)."""
import time

from butler_agent.rule_ops import RuleOps


class _Policy:
    def create(self, rule):
        return rule.model_copy(update={"policy_status": "active", "active": True})

    def disable(self, rule):
        return rule.model_copy(update={"policy_status": "disabled", "active": False})


def test_apply_rule_waits_for_settle_window(store, monkeypatch):
    from butler_rules import Identities, default_rules
    ids = Identities.local()
    rule = default_rules("hh_t", ids, "2026-10-16T12:00:00+00:00")[0].model_copy(update={"active": False, "policy_status": "draft"})
    store.put_rule(rule)
    ops = RuleOps(store, drafter=None, policy=_Policy(), ids=ids, settle_ms=300)
    t0 = time.monotonic()
    out = ops.apply_rule({"household_id": "hh_t", "rule_id": rule.rule_id})
    assert out["ok"] and time.monotonic() - t0 >= 0.29


def test_apply_rule_without_settle_is_immediate(store):
    from butler_rules import Identities, default_rules
    ids = Identities.local()
    rule = default_rules("hh_t", ids, "2026-10-16T12:00:00+00:00")[0].model_copy(update={"active": False, "policy_status": "draft"})
    store.put_rule(rule)
    ops = RuleOps(store, drafter=None, policy=_Policy(), ids=ids, settle_ms=0)
    t0 = time.monotonic()
    assert ops.apply_rule({"household_id": "hh_t", "rule_id": rule.rule_id})["ok"]
    assert time.monotonic() - t0 < 0.2


def test_propagating_rule_is_finished_in_the_background(store):
    """A rule still activating returns POLICY_PROPAGATING at once; a background thread marks it active later."""
    from butler_rules import Identities, PolicyPropagatingError, default_rules

    ids = Identities.local()
    rule = default_rules("hh_t", ids, "2026-10-16T12:00:00+00:00")[0].model_copy(update={"active": False, "policy_status": "draft"})
    store.put_rule(rule)

    class SlowPolicy(_Policy):
        def create(self, r):
            raise PolicyPropagatingError(r.model_copy(update={"policy_status": "creating", "policy_id": "p1"}))

        def finish(self, r):
            time.sleep(0.2)
            return r.model_copy(update={"policy_status": "active", "active": True})

    ops = RuleOps(store, drafter=None, policy=SlowPolicy(), ids=ids, settle_ms=0)
    out = ops.apply_rule({"household_id": "hh_t", "rule_id": rule.rule_id})
    assert out["ok"] is False and out["error"]["code"] == "POLICY_PROPAGATING"
    assert store.get_rule("hh_t", rule.rule_id).policy_status == "creating"
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and store.get_rule("hh_t", rule.rule_id).policy_status != "active":
        time.sleep(0.05)
    assert store.get_rule("hh_t", rule.rule_id).active is True
