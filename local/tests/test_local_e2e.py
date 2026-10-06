"""End to end, offline: seeded moto store + in-process local Gateway (real Cedar) + wrapper + executor + debug API."""
import logging
import time

import pytest
from butler_actions.gateway import HttpGatewayClient
from butler_actions.ids import new_id
from butler_actions.lint import lint_spoken
from butler_actions.wrapper import RunGuard, agent_tool_text, call_action
from butler_contracts.models import Decision, DecisionOption, Need, Plan, Receipt, RuleDraft
from butler_executor.handler import handler as executor_handler
from butler_local.gateway import create_app
from butler_local.seed import seed
from butler_rules import Identities, LocalPolicyService, draft_to_rule
from debug_api.app import create_app as create_debug_app
from starlette.testclient import TestClient

HH = "hh_demo"
DELAY_MS = 300
IDS = Identities.local()


class Effects:
    """Stands in for butler_action_handlers.dispatch: records what actually ran."""

    def __init__(self):
        self.ran = []

    def __call__(self, tool, event, **kw):
        self.ran.append((tool, event))
        n = len(self.ran)
        if tool == "Supplies___checkout":
            return {"ok": True, "data": {"order_id": f"ord_{n}", "payment_ref": f"pay_{n}", "amount_minor": event["amount_minor"],
                                         "eta": "Friday", "simulated_merchant": True, "payment_mode": "test"}}
        if tool == "Messages___send_email":
            return {"ok": True, "data": {"message_ids": ["m1"], "sent_to": ["x"]}}
        return {"ok": True, "data": {"refund_ref": "r1", "amount_minor": 0}}


@pytest.fixture
def world(store, pinned_now):
    seed(store, now=pinned_now, ids=IDS)
    effects = Effects()
    http = TestClient(create_app(store, IDS, delay_ms=DELAY_MS, dispatch=effects), base_url="http://gateway.local")
    gateway = HttpGatewayClient("http://gateway.local/mcp", {"butler-agent": lambda: "local-agent-token",
                                                             "approval-executor": lambda: "local-executor-token"},
                                client=http, household_id=HH)
    return store, gateway, effects


def act(world, principal, tool, args, **kw):
    store, gateway, _ = world
    return call_action(principal, tool, args, household_id=HH, correlation_id=new_id("cor"), store=store, gateway=gateway, **kw)


def checkout(amount, category="drinks"):
    return {"merchant": "FreshCart", "items": [{"sku": "drk-soda-12", "qty": 3}], "amount_minor": amount, "currency": "USD",
            "category": category, "reasoning": {"reasons": ["Six guests are coming"], "context_used": ["calendar: Fri 7 PM dinner"],
                                                "alternatives": [{"option": "BigBox", "rejected_because": "arrives Saturday"}]}}


def test_full_trust_loop(world, caplog):
    store, gateway, effects = world
    guard = RunGuard()

    # 1. under the 50 dollar cap: ALLOW, receipt saved, matcher and gateway agree
    ok = act(world, "butler-agent", "Supplies___checkout", checkout(4200), need_id="need_drinks", guard=guard)
    assert ok.status == "executed" and ok.receipt.authority.decision == "ALLOW" and ok.receipt.authority.matcher_gateway_agree
    assert store.get_receipt(HH, ok.receipt.action_id) == ok.receipt and len(effects.ran) == 1
    assert ok.receipt.might_disagree.score == 0.45 and ok.receipt.reversible
    # the allowing rule is named on the receipt ("ALLOWED by ...")
    assert ok.receipt.authority.rule_ids == ["rule_default_spend"]
    assert ok.receipt.authority.rule_texts == ["Ask me before spending more than 50 dollars."]
    assert ok.receipt.spoken_summary == "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it."

    # 2. over the cap: DENY by rule_default_spend, held for approval, with the rule text on the receipt
    held = act(world, "butler-agent", "Supplies___checkout", checkout(5200), need_id="need_party", guard=guard)
    assert held.status == "held_for_approval" and len(effects.ran) == 1
    assert held.denied_rule == {"rule_id": "rule_default_spend", "rule_text": "Ask me before spending more than 50 dollars.",
                                "effect": "ask_first"}
    stored = store.get_receipt(HH, held.receipt.action_id)
    assert stored.status == "held_for_approval" and stored.authority.decision == "DENY" and stored.authority.matcher_gateway_agree
    assert stored.authority.rule_ids == ["rule_default_spend"] and stored.authority.rule_texts == [held.denied_rule["rule_text"]]
    assert agent_tool_text(held).startswith('DENIED by rule "Ask me before spending more than 50 dollars." (ask_first)')
    retry = act(world, "butler-agent", "Supplies___checkout", checkout(4999, "groceries"), need_id="need_party", guard=guard)
    assert retry.status == "blocked" and retry.error["code"] == "DENIED_RETRY_BLOCKED" and len(effects.ran) == 1

    # 2b. approving the held action runs it as the executor (policy lets it through), receipt links the decision
    _, need = _plan_with_pending_decision(store, held.receipt.action.args)
    approved = executor_handler({"mode": "decision", "household_id": HH, "correlation_id": "cor_x",
                                 "decision_id": need["decision_id"], "option_id": "opt_go"}, store=store, gateway=gateway)
    assert approved["ok"] and approved["data"]["receipt"]["authority"]["principal"] == "approval-executor"
    assert approved["data"]["receipt"]["decision_id"] == need["decision_id"] and len(effects.ran) == 2

    # 3. a correction becomes an ask_category rule; after the propagation delay agent is held, executor is not
    draft = RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                      effect="ask_first", confidence=0.95)
    rule = draft_to_rule(draft, HH, origin={"type": "correction", "utterance": "don't buy drinks without asking",
                                            "created_at": "2026-10-06T12:00:00+00:00"}, now="2026-10-06T12:00:00+00:00", ids=IDS)
    store.put_rule(rule)
    LocalPolicyService(store, ids=IDS, activation_delay_ms=50).create(rule)
    time.sleep(DELAY_MS / 1000 + 0.1)
    drinks = checkout(3100)
    denied = act(world, "butler-agent", "Supplies___checkout", drinks, need_id="need_drinks2")
    assert denied.status == "held_for_approval" and denied.denied_rule["rule_text"] == "Ask me before buying drinks."
    assert denied.receipt.authority.matcher_gateway_agree and denied.receipt.spoken_summary == \
        "I held it because you asked me to check before buying drinks."
    allowed = act(world, "approval-executor", "Supplies___checkout", drinks, need_id="need_drinks2", decision_id="dec_x")
    assert allowed.status == "executed" and allowed.receipt.authority.matcher_gateway_agree
    assert act(world, "butler-agent", "Supplies___checkout", checkout(3100, "groceries")).status == "executed"  # other categories unaffected

    # 4. a never rule denies both principals, even for an approved action
    never = draft_to_rule(RuleDraft(template="never_contact", params={"contact_id": "c_jordan", "contact_name": "Jordan"},
                                    text="Never email Jordan.", effect="never", confidence=0.9), HH,
                          origin={"type": "default"}, now="2026-10-06T12:00:00+00:00", ids=IDS)
    LocalPolicyService(store, ids=IDS).create(never)
    time.sleep(DELAY_MS / 1000 + 0.1)
    mail = {"recipient_contact_ids": ["c_jordan"], "subject": "Hi", "body_text": "Hello", "kind": "other"}
    for principal in ("butler-agent", "approval-executor"):
        out = act(world, principal, "Messages___send_email", mail)
        assert out.status == "blocked" and out.denied_rule["effect"] == "never" and out.receipt.authority.matcher_gateway_agree
    assert act(world, "butler-agent", "Messages___send_email", {**mail, "recipient_contact_ids": ["c_tolu"]}).status == "executed"

    # every receipt validates, every spoken summary passes the lint, and no parity mismatch was ever logged
    receipts = store.list_receipts(HH)
    for r in receipts:
        Receipt.model_validate(r.model_dump())
        assert lint_spoken(r.spoken_summary) == [], r.spoken_summary
    assert all(r.authority.matcher_gateway_agree for r in receipts)
    assert "PARITY_MISMATCH" not in caplog.text

    # the Black Box panel's view of the same history
    debug = TestClient(create_debug_app(store))
    events = debug.get("/policy-events", headers={"Authorization": "Bearer local-debug-token"}).json()["events"]
    assert [e["decision"] for e in events].count("DENY") == 5 and any(e["rule_ids"] == ["rule_default_spend"] for e in events)


def _plan_with_pending_decision(store, args):
    pid, nid, did = new_id("plan"), new_id("need"), new_id("dec")
    ts = "2026-10-06T12:00:00+00:00"
    store.put_plan(Plan(plan_id=pid, household_id=HH, situation="s", kind="hosting", title="Dinner", status="waiting_on_you",
                        created_at=ts, updated_at=ts,
                        needs=[Need(need_id=nid, plan_id=pid, label="Buy drinks", capability="supplies", status="needs_you",
                                    decision_id=did, action_ids=[], updated_at=ts)]))
    store.put_decision(HH, Decision(
        decision_id=did, plan_id=pid, need_id=nid, kind="approve_action", question="Buy drinks for 52 dollars?", status="pending",
        created_at=ts, options=[DecisionOption(option_id="opt_go", title="Buy", tradeoff="as planned",
                                               action_draft={"tool": "Supplies___checkout", "args": args, "summary": "Buy drinks"})]))
    return pid, {"decision_id": did, "need_id": nid}


def test_rule_inside_propagation_window_is_a_logged_parity_mismatch(world, caplog):
    store, _, _ = world
    rule = draft_to_rule(RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                                   effect="ask_first", confidence=0.95), HH, origin={"type": "default"},
                         now="2026-10-06T12:00:00+00:00", ids=IDS)
    LocalPolicyService(store, ids=IDS).create(rule)  # stamped "now" in real time: the Gateway has not caught up
    with caplog.at_level(logging.ERROR, logger="butler.wrapper"):
        out = act(world, "butler-agent", "Supplies___checkout", checkout(3100))
    assert out.status == "executed" and out.receipt.authority.matcher_gateway_agree is False
    assert "PARITY_MISMATCH" in caplog.text
    time.sleep(DELAY_MS / 1000 + 0.1)
    assert act(world, "butler-agent", "Supplies___checkout", checkout(3100)).status == "held_for_approval"


def test_defaults_enforced_for_every_default_rule(world):
    cases = [
        ("butler-agent", "Services___book_service", {"provider_id": "p", "service_type": "cleaning", "slot_start": "2026-10-09T15:00:00-04:00",
                                                    "amount_minor": 4000, "currency": "USD"}, "held_for_approval", "rule_default_services"),
        ("butler-agent", "Supplies___refund", {"order_id": "ord_1"}, "held_for_approval", "rule_default_refunds"),
        ("butler-agent", "Messages___send_email", {"recipient_email": "stranger@example.com", "subject": "s", "body_text": "b", "kind": "other"},
         "held_for_approval", "rule_default_contacts"),
        ("butler-agent", "Calendar___delete_event", {"event_id": "e", "event_owner": "human"}, "blocked", "rule_default_calendar"),
        ("approval-executor", "Calendar___delete_event", {"event_id": "e", "event_owner": "human"}, "blocked", "rule_default_calendar"),
        ("approval-executor", "Supplies___refund", {"order_id": "ord_1"}, "executed", None),
        ("approval-executor", "Messages___send_email", {"recipient_email": "stranger@example.com", "subject": "s", "body_text": "b", "kind": "other"},
         "executed", None),
    ]
    for principal, tool, args, status, rule_id in cases:
        out = act(world, principal, tool, args)
        assert out.status == status, (principal, tool, out.error)
        assert out.receipt.authority.matcher_gateway_agree
        assert (out.denied_rule or {}).get("rule_id") == rule_id


def test_gateway_dispatches_to_real_action_handlers_when_available(store, pinned_now):
    """Smoke test against Workstream B's handlers (read-only catalogue search, no network)."""
    from butler_action_handlers import dispatch  # noqa: F401  (skip if missing)

    seed(store, now=pinned_now, ids=IDS)
    http = TestClient(create_app(store, IDS, delay_ms=0), base_url="http://gateway.local")  # default dispatch
    gateway = HttpGatewayClient("http://gateway.local/mcp", {"butler-agent": lambda: "local-agent-token"}, client=http, household_id=HH)
    out = call_action("butler-agent", "Supplies___search_products", {"query": "soda", "category": "drinks"}, household_id=HH,
                      correlation_id="cor_real", store=store, gateway=gateway)
    assert out.status == "executed", out.error
    assert out.data is not None and "products" in out.data and out.data.get("stub") is None
