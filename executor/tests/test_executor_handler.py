from concurrent.futures import ThreadPoolExecutor

import pytest
from butler_actions.ids import new_id
from butler_actions.testing import CedarFakeGateway
from butler_actions.wrapper import call_action
from butler_contracts.models import Decision, DecisionOption, Need, Plan, RuleDraft
from butler_executor.handler import handler
from butler_executor.server import create_app
from butler_rules import Identities, LocalPolicyService, draft_to_rule
from starlette.testclient import TestClient

HH = "hh_t"
TS = "2026-10-06T12:00:00+00:00"
CHECKOUT_5200 = {"merchant": "FreshCart", "items": [{"sku": "drk-1", "qty": 3}], "amount_minor": 5200,
                 "currency": "USD", "category": "drinks", "idempotency_key": "k-5200", "correlation_id": "c0"}


def make_plan(store, *, args=None, tool="Supplies___checkout", kind="approve_action", options=None):
    pid, nid, did = new_id("plan"), new_id("need"), new_id("dec")
    store.put_plan(Plan(plan_id=pid, household_id=HH, situation="s", kind="hosting", title="Dinner", status="waiting_on_you",
                        created_at=TS, updated_at=TS,
                        needs=[Need(need_id=nid, plan_id=pid, label="Buy drinks", capability="supplies",
                                    status="needs_you", decision_id=did, action_ids=[], updated_at=TS)]))
    opts = options or [DecisionOption(option_id="opt_1", title="Buy drinks", tradeoff="as planned",
                                      action_draft={"tool": tool, "args": args or CHECKOUT_5200, "summary": "Buy drinks, 52 dollars"})]
    dec = Decision(decision_id=did, plan_id=pid, need_id=nid, kind=kind, question="OK?", options=opts, status="pending",
                   created_at=TS)
    store.put_decision(HH, dec)
    return pid, nid, did


def req(did, option="opt_1"):
    return {"mode": "decision", "household_id": HH, "correlation_id": "cor_x", "decision_id": did, "option_id": option}


def add_never(store, template, params, text):
    ids = Identities.local()
    rule = draft_to_rule(RuleDraft(template=template, params=params, text=text, effect="never", confidence=1), HH,
                         origin={"type": "default"}, now=TS, ids=ids)
    LocalPolicyService(store, ids=ids).create(rule)


def test_approve_ask_first_executes_as_executor(seeded):
    pid, nid, did = make_plan(seeded)
    gw = CedarFakeGateway(seeded)
    res = handler(req(did), store=seeded, gateway=gw)
    assert res["ok"], res
    dec, rec = res["data"]["decision"], res["data"]["receipt"]
    assert dec["status"] == "executed" and dec["chosen_option_id"] == "opt_1" and dec["result_action_id"] == rec["action_id"]
    assert rec["status"] == "executed" and rec["decision_id"] == did and rec["authority"]["principal"] == "approval-executor"
    assert rec["authority"]["matcher_gateway_agree"] and rec["plan_id"] == pid and rec["need_id"] == nid
    assert [(p, t) for p, t, _ in gw.calls] == [("approval-executor", "Supplies___checkout")]
    need = seeded.get_need(pid, nid)
    assert need.status == "done" and need.action_ids == [rec["action_id"]] and "approved" in need.note
    assert seeded.get_decision(pid, did).status == "executed"
    assert seeded.get_receipt(HH, rec["action_id"]).decision_id == did


def test_double_approval_executes_once(seeded):
    _, _, did = make_plan(seeded)
    gw = CedarFakeGateway(seeded)
    first = handler(req(did), store=seeded, gateway=gw)
    second = handler(req(did), store=seeded, gateway=gw)
    assert first["ok"] and second["ok"] and second["data"]["replayed"]
    assert second["data"]["receipt"]["action_id"] == first["data"]["receipt"]["action_id"]
    assert len(gw.calls) == 1 and len(seeded.list_receipts(HH)) == 1


def test_concurrent_approvals_execute_once(seeded):
    _, _, did = make_plan(seeded)
    gw = CedarFakeGateway(seeded)
    with ThreadPoolExecutor(6) as pool:
        results = list(pool.map(lambda _: handler(req(did), store=seeded, gateway=gw), range(6)))
    assert len(gw.calls) == 1
    assert sum(1 for r in results if r["ok"] and not r["data"].get("replayed")) == 1
    assert len(seeded.list_receipts(HH)) == 1


def test_never_rule_returns_blocked_by_never_rule(seeded):
    add_never(seeded, "never_tool", {"tool": "Supplies___checkout"}, "Never buy anything.")
    pid, nid, did = make_plan(seeded)
    gw = CedarFakeGateway(seeded)
    res = handler(req(did), store=seeded, gateway=gw)
    assert not res["ok"] and res["error"]["code"] == "BLOCKED_BY_NEVER_RULE"
    assert res["error"]["message"] == "Your rule says never to do that, so I didn't."
    assert gw.calls == []
    assert seeded.get_decision(pid, did).status == "failed"
    need = seeded.get_need(pid, nid)
    assert need.status == "skipped" and "Never buy anything." in need.note
    rec = res["data"]["receipt"]
    assert rec["status"] == "blocked" and rec["authority"]["principal"] == "approval-executor" and rec["decision_id"] == did


def test_lambda_failure_marks_failed_and_blocked(store, pinned_now):
    gw = CedarFakeGateway(store, handler=lambda t, a: {"ok": False, "error": {"code": "UPSTREAM_UNAVAILABLE", "message": "store down"}})
    pid, nid, did = make_plan(store)
    res = handler(req(did), store=store, gateway=gw)
    assert not res["ok"] and res["error"]["code"] == "UPSTREAM_UNAVAILABLE"
    assert store.get_decision(pid, did).status == "failed" and store.get_need(pid, nid).status == "blocked"
    assert res["data"]["receipt"]["status"] == "failed"


def test_choose_option_runs_the_chosen_options_draft(seeded):
    opts = [DecisionOption(option_id=f"opt_{i}", title=f"Cleaner {i}", tradeoff="x",
                           action_draft={"tool": "Services___book_service", "summary": "Book",
                                         "args": {"provider_id": f"p{i}", "service_type": "cleaning", "slot_start": TS,
                                                  "amount_minor": 9000 + i, "currency": "USD", "idempotency_key": f"k{i}",
                                                  "correlation_id": "c"}}) for i in (1, 2)]
    _, _, did = make_plan(seeded, kind="choose_option", options=opts)
    gw = CedarFakeGateway(seeded)
    res = handler(req(did, "opt_2"), store=seeded, gateway=gw)
    assert res["ok"] and res["data"]["decision"]["chosen_option_id"] == "opt_2"
    assert gw.calls[0][2]["provider_id"] == "p2"  # approved although the agent would be held by two default rules
    assert res["data"]["receipt"]["reversible"]


@pytest.mark.parametrize(("event", "code"), [
    ({"mode": "decision", "household_id": HH, "correlation_id": "c", "decision_id": "dec_nope", "option_id": "o"}, "NOT_FOUND"),
    ({"mode": "nope"}, "INVALID_INPUT"),
    ({"mode": "decision", "household_id": HH}, "INVALID_INPUT"),
    ({"mode": "undo", "household_id": HH, "correlation_id": "c", "action_id": "act_nope"}, "NOT_FOUND"),
])
def test_bad_requests(seeded, event, code):
    assert handler(event, store=seeded, gateway=CedarFakeGateway(seeded))["error"]["code"] == code


def test_unknown_option_and_option_without_draft_and_non_pending(seeded):
    gw = CedarFakeGateway(seeded)
    pid, _, did = make_plan(seeded)
    assert handler(req(did, "opt_zzz"), store=seeded, gateway=gw)["error"]["code"] == "INVALID_INPUT"
    assert seeded.get_decision(pid, did).status == "pending"
    skip = [DecisionOption(option_id="skip", title="Skip", tradeoff="no")]
    _, _, d2 = make_plan(seeded, kind="choose_option", options=skip)
    assert handler(req(d2, "skip"), store=seeded, gateway=gw)["error"]["code"] == "INVALID_INPUT"
    seeded.transition_decision(HH, pid, did, "pending", "rejected")
    res = handler(req(did), store=seeded, gateway=gw)
    assert res["error"]["code"] == "INVALID_INPUT" and "rejected" in res["error"]["message"]
    assert gw.calls == []


# ── undo ──────────────────────────────────────────────────────────────────
def original(store, gw, tool, args, **kw):
    out = call_action("approval-executor", tool, args, household_id=HH, correlation_id="c1", store=store, gateway=gw, **kw)
    assert out.status == "executed"
    return out.receipt


def undo(store, gw, action_id):
    return handler({"mode": "undo", "household_id": HH, "correlation_id": "cor_u", "action_id": action_id}, store=store, gateway=gw)


@pytest.mark.parametrize(("tool", "args", "undo_tool", "expect_args"), [
    ("Supplies___checkout", {"merchant": "m", "items": [{"sku": "s", "qty": 1}], "amount_minor": 4200, "currency": "USD", "category": "drinks"},
     "Supplies___refund", lambda r: {"order_id": r["order_id"]}),
    ("Services___book_service", {"provider_id": "p", "service_type": "cleaning", "slot_start": TS, "amount_minor": 9000, "currency": "USD"},
     "Services___cancel_booking", lambda r: {"booking_id": r["booking_id"]}),
    ("Calendar___create_event", {"title": "Dinner", "start": TS, "end": TS},
     "Calendar___delete_event", lambda r: {"event_id": r["event_id"], "event_owner": "butler"}),
])
def test_undo_maps_tools(seeded, tool, args, undo_tool, expect_args):
    gw = CedarFakeGateway(seeded)
    orig = original(seeded, gw, tool, args)
    assert orig.reversible
    res = undo(seeded, gw, orig.action_id)
    assert res["ok"], res
    assert res["data"]["original"]["status"] == "undone"
    up = res["data"]["undo"]
    assert up["undo_of"] == orig.action_id and up["action"]["tool"] == undo_tool and up["status"] == "executed"
    assert up["authority"]["principal"] == "approval-executor"
    sent = gw.calls[-1][2]
    assert {k: sent[k] for k in expect_args(orig.result)} == expect_args(orig.result)
    assert seeded.get_receipt(HH, orig.action_id).status == "undone"
    assert seeded.get_receipt(HH, up["action_id"]).undo_of == orig.action_id
    again = undo(seeded, gw, orig.action_id)  # a second undo is refused, nothing re-run
    assert again["error"]["code"] == "NOT_REVERSIBLE" and "already" in again["error"]["message"]


def test_send_email_is_not_reversible(seeded):
    gw = CedarFakeGateway(seeded)
    orig = original(seeded, gw, "Messages___send_email", {"recipient_contact_ids": ["c_tolu"], "subject": "s", "body_text": "b", "kind": "invite"})
    assert not orig.reversible
    res = undo(seeded, gw, orig.action_id)
    assert res["error"] == {"code": "NOT_REVERSIBLE", "message": "I can't undo an email once it's sent."}
    assert seeded.get_receipt(HH, orig.action_id).status == "executed"


def test_undo_blocked_by_never_rule(seeded):
    gw = CedarFakeGateway(seeded)
    orig = original(seeded, gw, "Supplies___checkout", {"merchant": "m", "items": [{"sku": "s", "qty": 1}], "amount_minor": 100,
                                                       "currency": "USD", "category": "drinks"})
    add_never(seeded, "never_tool", {"tool": "Supplies___refund"}, "Never refund.")
    res = undo(seeded, gw, orig.action_id)
    assert res["error"]["code"] == "BLOCKED_BY_NEVER_RULE"
    assert seeded.get_receipt(HH, orig.action_id).status == "executed"


def test_undo_failure_leaves_original_untouched(store, pinned_now):
    ok_gw = CedarFakeGateway(store)
    orig = original(store, ok_gw, "Supplies___checkout", {"merchant": "m", "items": [{"sku": "s", "qty": 1}], "amount_minor": 100,
                                                         "currency": "USD", "category": "drinks"})
    bad = CedarFakeGateway(store, handler=lambda t, a: {"ok": False, "error": {"code": "INTERNAL", "message": "boom"}})
    res = undo(store, bad, orig.action_id)
    assert res["error"]["code"] == "INTERNAL" and store.get_receipt(HH, orig.action_id).status == "executed"


# ── HTTP server ───────────────────────────────────────────────────────────
def test_server_invoke(seeded):
    _, _, did = make_plan(seeded)
    client = TestClient(create_app(seeded, CedarFakeGateway(seeded)))
    assert client.get("/health").json()["ok"]
    res = client.post("/invoke", json=req(did))
    assert res.status_code == 200 and res.json()["ok"] and res.json()["data"]["decision"]["status"] == "executed"
    assert client.post("/invoke", content=b"nope").status_code == 400
    assert client.post("/invoke", json=[1]).status_code == 400
    assert client.post("/invoke", json={"mode": "x"}).json()["error"]["code"] == "INVALID_INPUT"
