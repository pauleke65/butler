import json
import runpy
import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path

from butler_actions.lint import lint_spoken
from butler_actions.scoring import might_disagree
from butler_actions.store import Store
from butler_local import devdb
from butler_local.seed import history_receipt, seed
from butler_rules import DEFAULT_RULE_IDS, Identities

SEED = Path(__file__).resolve().parents[2] / "seed"
NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)
HH = "hh_demo"


def test_seed_loads_everything(store):
    summary = seed(store, now=NOW, ids=Identities.local())
    assert summary == {"household_id": HH, "removed": 0, "rules": 5, "receipts": 5}
    assert store.get_household(HH).timezone == "America/New_York"
    assert len(store.list_contacts(HH)) == 9 and store.get_contact(HH, "c_jordan").first_name == "Jordan"
    assert [m["member_id"] for m in store.list_members(HH)] == ["mem_paul"]
    rules = store.list_rules(HH)
    assert sorted(r.rule_id for r in rules) == sorted(DEFAULT_RULE_IDS)
    assert all(r.active and r.policy_status == "active" and r.policy_id for r in rules)
    assert [r.rule_id for r in store.list_rules(HH, active_only=True)].__len__() == 5


def test_history_receipts_match_history_json(store):
    seed(store, now=NOW, ids=Identities.local())
    entries = json.loads((SEED / "history.json").read_text())["receipts"]
    got = {r.created_at: r for r in store.list_receipts(HH)}
    assert len(got) == len(entries)
    for e in entries:
        r = got[(NOW - timedelta(days=e["days_ago"])).isoformat(timespec="seconds")]
        assert r.status == "executed" and r.action.tool == e["tool"] and r.title == e["title"]
        assert r.action.args["amount_minor"] == e["amount_minor"] and r.cost.amount_minor == e["amount_minor"]
        assert r.action.args["merchant"] == e["merchant"] and r.action.args["category"] == e["category"]
        assert r.action.args["items"] == e["items"]
        assert r.authority.decision == "ALLOW" and r.authority.matcher_gateway_agree and r.simulated
        assert lint_spoken(r.spoken_summary) == [], r.spoken_summary
    ids = [r.action_id for r in store.list_receipts(HH, newest_first=False)]
    assert ids == sorted(ids)  # ULID order == chronological order


def test_seed_story_supports_might_disagree_demo(store):
    seed(store, now=NOW, ids=Identities.local())
    score = might_disagree(store, HH, "Supplies___checkout",
                           {"category": "drinks", "merchant": "FreshCart", "amount_minor": 4200}, None, NOW)
    assert score["score"] >= 0.3  # near the cap and above the usual price
    cleaner = might_disagree(store, HH, "Services___book_service", {"service_type": "cleaning", "provider_id": "p", "amount_minor": 9000}, None, NOW)
    assert cleaner["top_reason"] == "It's the first time I booked a cleaner"


def test_seed_is_idempotent(store):
    seed(store, now=NOW, ids=Identities.local())
    seed(store, now=NOW, ids=Identities.local())
    assert len(store.list_receipts(HH)) == 5 and len(store.list_rules(HH)) == 5 and len(store.list_contacts(HH)) == 9


def test_reset_clears_demo_state_but_keeps_household_contacts_defaults(store):
    from butler_actions.ids import new_id
    from butler_contracts.models import Decision, DecisionOption, Need, Plan, RuleDraft
    from butler_rules import LocalPolicyService, draft_to_rule

    ids = Identities.local()
    seed(store, now=NOW, ids=ids)
    pid, nid = new_id("plan"), new_id("need")
    ts = NOW.isoformat()
    store.put_plan(Plan(plan_id=pid, household_id=HH, situation="s", kind="hosting", title="t", status="active", created_at=ts,
                        updated_at=ts, needs=[Need(need_id=nid, plan_id=pid, label="l", capability="supplies", status="doing",
                                                   action_ids=[], updated_at=ts)]))
    store.put_decision(HH, Decision(decision_id=new_id("dec"), plan_id=pid, need_id=nid, kind="choose_option", question="q",
                                    options=[DecisionOption(option_id="o", title="t", tradeoff="x")], status="pending", created_at=ts))
    store.put_record(HH, "order", "ord_x", {"a": 1})
    store.put_record(HH, "booking", "bkg_x", {"a": 1})
    store.put_record(HH, "event", "evt_x", {"a": 1})
    store.put_idempotent("k-demo", {"ok": True})
    extra = draft_to_rule(RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                                    effect="ask_first", confidence=1), HH, origin={"type": "default"}, now=ts, ids=ids)
    LocalPolicyService(store, ids=ids).create(extra)
    # the demo also disabled a default rule: reset restores it
    store.put_rule(store.get_rule(HH, "rule_default_refunds").model_copy(update={"active": False, "policy_status": "disabled"}))

    out = seed(store, do_reset=True, now=NOW, ids=ids)
    assert out["removed"] > 0
    assert store.list_plans(HH) == [] and store.list_pending_decisions(HH) == []
    assert store.list_records(HH, "order") == [] and store.list_records(HH, "booking") == [] and store.list_records(HH, "event") == []
    assert store.get_idempotent("k-demo") is None
    assert sorted(r.rule_id for r in store.list_rules(HH)) == sorted(DEFAULT_RULE_IDS)
    assert all(r.active for r in store.list_rules(HH))
    assert store.get_household(HH) and len(store.list_contacts(HH)) == 9
    assert len(store.list_receipts(HH)) == 5  # history reloaded, nothing else


def test_history_receipt_validates_for_each_entry():
    entries = json.loads((SEED / "history.json").read_text())["receipts"]
    for i, e in enumerate(entries):
        r = history_receipt(HH, e, i, NOW)
        assert r.might_disagree.score == 0 and r.reversible and r.result["order_id"].startswith("ord_seed")


def test_seed_wrapper_script_imports():
    ns = runpy.run_path(str(SEED / "load.py"), run_name="not_main")
    assert callable(ns["main"])


# ── devdb: a real moto server on a free port ──────────────────────────────
def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_devdb_starts_moto_server_with_table():
    port = _free_port()
    server = devdb.start(port)
    try:
        store = Store(endpoint_url=devdb.endpoint(port))
        assert store.table_name == "butler-local"
        seed(store, now=NOW, ids=Identities.local())
        assert len(store.list_receipts(HH)) == 5
        assert devdb.ensure_table(port).table_name == "butler-local"  # idempotent
    finally:
        server.stop()
