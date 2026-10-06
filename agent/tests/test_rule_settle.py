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
