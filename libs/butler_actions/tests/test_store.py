from butler_actions.ids import new_id
from butler_contracts.models import Decision, DecisionOption, Need, Plan, Receipt, Rule


def _plan(hh="hh_t"):
    pid = new_id("plan")
    n = Need(need_id=new_id("need"), plan_id=pid, label="Invite guests", capability="messages",
             status="doing", action_ids=[], updated_at="2026-10-16T12:00:00+00:00")
    return Plan(plan_id=pid, household_id=hh, situation="six friends", kind="hosting", title="Dinner",
                status="active", needs=[n], created_at="2026-10-16T12:00:00+00:00", updated_at="2026-10-16T12:00:00+00:00")


def test_plan_roundtrip_with_needs(store):
    p = _plan()
    store.put_plan(p)
    got = store.get_plan("hh_t", p.plan_id)
    assert got and got.title == "Dinner" and len(got.needs) == 1
    assert [x.plan_id for x in store.list_plans("hh_t")] == [p.plan_id]


def test_decision_transition_is_atomic(store):
    p = _plan(); store.put_plan(p)
    dec = Decision(decision_id=new_id("dec"), plan_id=p.plan_id, need_id=p.needs[0].need_id, kind="choose_option",
                   question="Which?", options=[DecisionOption(option_id="o1", title="A", tradeoff="x")],
                   status="pending", created_at="2026-10-16T12:00:00+00:00")
    store.put_decision("hh_t", dec)
    assert [d.decision_id for d in store.list_pending_decisions("hh_t")] == [dec.decision_id]
    first = store.transition_decision("hh_t", p.plan_id, dec.decision_id, "pending", "approved", chosen_option_id="o1")
    second = store.transition_decision("hh_t", p.plan_id, dec.decision_id, "pending", "approved")
    assert first and first.status == "approved" and second is None
    assert store.list_pending_decisions("hh_t") == []


def test_idempotency_first_write_wins(store):
    assert store.put_idempotent("k1", {"a": 1}) is True
    assert store.put_idempotent("k1", {"a": 2}) is False
    assert store.get_idempotent("k1") == {"a": 1}


def test_receipts_newest_first(store):
    ids = []
    for i in range(3):
        aid = new_id("act", 1_700_000_000_000 + i * 1000)
        ids.append(aid)
        store.put_receipt(Receipt(
            action_id=aid, household_id="hh_t", correlation_id="c", action={"tool": "Messages___send_email", "args": {}},
            title="t", status="executed", reasons=[], context_used=[], alternatives=[],
            authority={"decision": "ALLOW", "principal": "butler-agent", "rule_ids": [], "rule_texts": [],
                       "evaluated_at": "2026-10-16T12:00:00+00:00", "matcher_gateway_agree": True},
            reversible=False, might_disagree={"score": 0}, simulated=False, spoken_summary="s",
            created_at="2026-10-16T12:00:00+00:00"))
    assert [r.action_id for r in store.list_receipts("hh_t")] == list(reversed(ids))
