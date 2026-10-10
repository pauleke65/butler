import logging

import pytest
from butler_actions.gateway import GatewayResponse
from butler_actions.lint import lint_spoken
from butler_actions.testing import CedarFakeGateway
from butler_actions.wrapper import (
    RunGuard,
    agent_tool_text,
    call_action,
    default_idempotency_key,
)
from butler_contracts.models import Need, Plan, Receipt, RuleDraft
from butler_rules import Identities, LocalPolicyService, draft_to_rule

CO = "Supplies___checkout"
AGENT, EXEC = "butler-agent", "approval-executor"
REASONING = {"reasons": ["Six guests are coming", "FreshCart is cheapest", "Arrives Friday", "extra"],
             "context_used": ["calendar: Fri 7 PM dinner"], "confidence": 0.9,
             "alternatives": [{"option": "BigBox", "rejected_because": "arrives Saturday"}]}


def checkout(amount, category="drinks", **extra):
    return {"merchant": "FreshCart", "items": [{"sku": "drk-1", "qty": 2}], "amount_minor": amount,
            "currency": "USD", "category": category, "reasoning": REASONING, **extra}


def run(store, principal=AGENT, tool=CO, args=None, gateway=None, **kw):
    gateway = gateway or CedarFakeGateway(store)
    kw.setdefault("household_id", "hh_t")
    kw.setdefault("correlation_id", "cor_1")
    return call_action(principal, tool, args if args is not None else checkout(4200), store=store, gateway=gateway, **kw), gateway


def assert_valid(store, outcome):
    stored = store.get_receipt("hh_t", outcome.receipt.action_id)
    assert stored == outcome.receipt
    Receipt.model_validate(stored.model_dump())
    assert lint_spoken(stored.spoken_summary) == [], stored.spoken_summary


def test_allow_under_cap(seeded):
    out, gw = run(seeded, plan_id="plan_1", need_id="need_1")
    r = out.receipt
    assert out.status == "executed" and out.denied_rule is None and out.data["order_id"].startswith("ord_")
    assert r.authority.decision == "ALLOW" and r.authority.matcher_gateway_agree and r.authority.principal == AGENT
    assert r.authority.gateway_request_id == "req-fake"
    assert r.title == "Bought drinks" and r.cost.amount_minor == 4200 and r.reversible and r.simulated
    assert r.spoken_summary == "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it."
    assert r.reasons == ["Six guests are coming", "FreshCart is cheapest", "Arrives Friday"]
    assert r.context_used == ["calendar: Fri 7 PM dinner"] and r.alternatives[0].option == "BigBox"
    assert r.might_disagree.score == 0.55 and "first time" in r.might_disagree.top_reason
    assert_valid(seeded, out)
    # the gateway never sees `reasoning`; it gets an idempotency key and correlation ids
    _, _, sent = gw.calls[0]
    assert "reasoning" not in sent and sent["correlation_id"] == "cor_1" and sent["plan_id"] == "plan_1"
    assert sent["idempotency_key"].startswith("plan_1:need_1:checkout:")


def test_deny_over_cap_is_held_with_rule_text(seeded):
    out, gw = run(seeded, args=checkout(5200), plan_id="plan_1", need_id="need_1")
    r = out.receipt
    assert out.status == "held_for_approval" and gw.calls == []
    assert out.denied_rule == {"rule_id": "rule_default_spend", "rule_text": "Ask me before spending more than 50 dollars.",
                               "effect": "ask_first"}
    assert r.status == "held_for_approval" and r.authority.decision == "DENY" and r.authority.matcher_gateway_agree
    assert r.authority.rule_ids == ["rule_default_spend"] and r.authority.rule_texts == [out.denied_rule["rule_text"]]
    assert r.title == "Tried to buy drinks" and r.might_disagree.score == 0 and not r.reversible and r.result is None
    assert r.spoken_summary == "I held it because you asked me to check before spending more than 50 dollars."
    assert_valid(seeded, out)
    assert agent_tool_text(out).startswith('DENIED by rule "Ask me before spending more than 50 dollars." (ask_first)')


def test_executor_passes_ask_first_with_decision_id(seeded):
    out, _ = run(seeded, principal=EXEC, args=checkout(5200), decision_id="dec_1")
    assert out.status == "executed" and out.receipt.decision_id == "dec_1"
    assert out.receipt.authority.principal == EXEC and out.receipt.authority.matcher_gateway_agree
    assert "You approved it." in out.receipt.spoken_summary
    assert_valid(seeded, out)


def test_never_rule_blocks_both_principals(seeded, pinned_now):
    ids = Identities.local()
    draft = RuleDraft(template="never_contact", params={"contact_id": "c_jordan", "contact_name": "Jordan"},
                      text="Never email Jordan.", effect="never", confidence=0.9)
    rule = draft_to_rule(draft, "hh_t", origin={"type": "default"}, now="2026-10-06T12:00:00+00:00", ids=ids)
    LocalPolicyService(seeded, ids=ids).create(rule)
    args = {"recipient_contact_ids": ["c_jordan"], "subject": "s", "body_text": "b", "kind": "other"}
    for principal in (AGENT, EXEC):
        out, gw = run(seeded, principal=principal, tool="Messages___send_email", args=args)
        assert out.status == "blocked" and out.denied_rule["effect"] == "never" and gw.calls == []
        assert out.receipt.authority.rule_texts == ["Never email Jordan."]
        assert "never email jordan" in out.receipt.spoken_summary.lower()
        assert_valid(seeded, out)
        assert "Do not retry" in agent_tool_text(out)


def test_parity_mismatch_logs_error_and_records_gateway_decision(seeded, caplog):
    gw = CedarFakeGateway(seeded)
    gw.force_decision = "DENY"  # matcher says ALLOW (4200 is under the cap)
    with caplog.at_level(logging.ERROR, logger="butler.wrapper"):
        out, _ = run(seeded, gateway=gw)
    r = out.receipt
    assert any("PARITY_MISMATCH" in m and "matcher=ALLOW" in m and "gateway=DENY" in m for m in caplog.messages)
    assert r.authority.matcher_gateway_agree is False and r.authority.decision == "DENY"
    assert out.status == "blocked" and out.denied_rule is None  # no rule explains it
    assert "no matching rule" in agent_tool_text(out)
    assert_valid(seeded, out)


def test_parity_mismatch_other_direction(seeded, caplog):
    gw = CedarFakeGateway(seeded)
    gw.force_decision = "ALLOW"  # gateway lets 5200 through although the matcher expects DENY
    with caplog.at_level(logging.ERROR, logger="butler.wrapper"):
        out, _ = run(seeded, args=checkout(5200), gateway=gw)
    assert out.status == "executed" and out.receipt.authority.decision == "ALLOW"
    assert out.receipt.authority.matcher_gateway_agree is False
    assert "PARITY_MISMATCH" in caplog.text


def test_lambda_failure_is_failed_receipt(store, pinned_now):
    gw = CedarFakeGateway(store, handler=lambda t, a: {"ok": False, "error": {"code": "INVALID_INPUT", "message": "amount mismatch"}})
    out, _ = run(store, gateway=gw)
    assert out.status == "failed" and out.error["code"] == "INVALID_INPUT" and out.data is None
    assert out.receipt.status == "failed" and out.receipt.authority.decision == "ALLOW"
    assert out.receipt.authority.matcher_gateway_agree
    assert agent_tool_text(out) == "FAILED: INVALID_INPUT: amount mismatch"
    assert_valid(store, out)


def test_transport_failure_does_not_count_as_parity_mismatch(seeded, caplog):
    class Down:
        def call(self, principal, tool, args):
            return GatewayResponse("error", None, {"code": "UPSTREAM_UNAVAILABLE", "message": "timeout"})

    with caplog.at_level(logging.ERROR):
        out, _ = run(seeded, args=checkout(5200), gateway=Down())
    assert out.status == "failed" and out.receipt.authority.matcher_gateway_agree
    assert out.receipt.authority.decision == "DENY"  # falls back to the matcher's decision
    assert "PARITY_MISMATCH" not in caplog.text and "couldn't buy drinks" in out.receipt.spoken_summary
    assert_valid(seeded, out)


def test_gateway_exception_still_writes_receipt(seeded):
    class Boom:
        def call(self, principal, tool, args):
            raise RuntimeError("kaboom")

    out, _ = run(seeded, gateway=Boom())
    assert out.status == "failed" and out.error["code"] == "UPSTREAM_UNAVAILABLE"
    assert_valid(seeded, out)


@pytest.mark.parametrize("args", [checkout("4200"), checkout(4200.5), checkout(True), {"category": "drinks"}])
def test_type_confused_policy_fields_fail_closed(seeded, args):
    out, gw = run(seeded, args=args)
    assert out.status == "failed" and out.error["code"] == "INVALID_INPUT" and gw.calls == []
    assert out.receipt.status == "failed"
    assert_valid(seeded, out)


def test_retry_after_deny_is_blocked_within_a_run(seeded):
    guard = RunGuard()
    gw = CedarFakeGateway(seeded)
    first, _ = run(seeded, args=checkout(5200), need_id="need_1", guard=guard, gateway=gw)
    assert first.status == "held_for_approval"
    retry, _ = run(seeded, args=checkout(4999, "groceries"), need_id="need_1", guard=guard, gateway=gw)  # dodge attempt
    assert retry.status == "blocked" and retry.error["code"] == "DENIED_RETRY_BLOCKED" and gw.calls == []
    assert retry.denied_rule["rule_id"] == "rule_default_spend"
    assert retry.receipt.status == "blocked" and retry.receipt.authority.decision == "DENY"
    assert retry.receipt.authority.matcher_gateway_agree
    assert agent_tool_text(retry).startswith("DENIED_RETRY_BLOCKED")
    assert_valid(seeded, retry)
    other_need, _ = run(seeded, args=checkout(100, "groceries"), need_id="need_2", guard=guard, gateway=gw)
    assert other_need.status == "executed"
    other_tool, _ = run(seeded, tool="Supplies___search_products", args={"query": "cola"}, need_id="need_1", guard=guard, gateway=gw)
    assert other_tool.status == "executed"
    assert guard.calls == 4
    assert len(seeded.list_receipts("hh_t")) == 4  # every call, including the blocked retry, has a receipt
    fresh, _ = run(seeded, args=checkout(100, "groceries"), need_id="need_1", guard=RunGuard(), gateway=gw)
    assert fresh.status == "executed"  # a new run starts clean


def test_idempotency_key_kept_when_present_and_default_is_stable():
    k1 = default_idempotency_key("p", "n", CO, {"a": 1, "b": 2})
    assert k1 == default_idempotency_key("p", "n", CO, {"b": 2, "a": 1}) != default_idempotency_key("p", "n", CO, {"a": 2})


def test_explicit_idempotency_key_is_kept(seeded):
    _, gw = run(seeded, args=checkout(100, "groceries", idempotency_key="mine"))
    assert gw.calls[0][2]["idempotency_key"] == "mine"


def test_plan_labels_come_from_the_store(seeded):
    plan = Plan(plan_id="plan_9", household_id="hh_t", situation="six friends Friday", kind="hosting", title="Dinner",
                status="active", created_at="2026-10-06T00:00:00+00:00", updated_at="2026-10-06T00:00:00+00:00",
                needs=[Need(need_id="need_9", plan_id="plan_9", label="Buy drinks", capability="supplies",
                            status="doing", action_ids=[], updated_at="2026-10-06T00:00:00+00:00")])
    seeded.put_plan(plan)
    out, _ = run(seeded, plan_id="plan_9", need_id="need_9")
    assert out.receipt.situation == "six friends Friday" and out.receipt.need_label == "Buy drinks"


def test_read_only_and_calendar_calls_get_receipts(seeded):
    out, _ = run(seeded, tool="Supplies___search_products", args={"query": "cola", "reasoning": {"reasons": ["need drinks"]}})
    assert out.status == "executed" and out.receipt.might_disagree.score == 0 and not out.receipt.reversible
    out, _ = run(seeded, tool="Calendar___create_event",
                 args={"title": "Dinner", "start": "2026-10-09T19:00:00-04:00", "end": "2026-10-09T22:00:00-04:00"})
    assert out.receipt.reversible and "7 PM Friday" in out.receipt.spoken_summary
    out, _ = run(seeded, tool="Calendar___update_event", args={"event_id": "e", "event_owner": "human"})
    assert out.status == "blocked" and "never change or delete events i created" in out.receipt.spoken_summary.lower()
    assert_valid(seeded, out)


def test_rules_param_overrides_store(store, pinned_now):
    out, _ = run(store, args=checkout(5200), rules=[])
    assert out.status == "executed"  # no rules passed and none in the store


@pytest.mark.parametrize("junk", ["text", 5, ["x"], {"reasons": "one string", "alternatives": [{"option": "a"}, "b", 3],
                                                    "context_used": {"a": 1}, "confidence": "high"},
                                  {"reasons": [None, {"x": 1}, "ok"], "alternatives": [{"option": "A", "rejected_because": "B"}]}])
def test_malformed_reasoning_never_prevents_a_receipt(seeded, junk):
    args = checkout(100, "groceries")
    args["reasoning"] = junk
    out, gw = run(seeded, args=args)
    assert out.status == "executed" and "reasoning" not in gw.calls[0][2]
    assert_valid(seeded, out)


def test_rule_still_activating_on_agentcore_is_honoured_without_calling_the_gateway(seeded):
    """AgentCore took 7-13 s to make a new policy ACTIVE (measured on the real service). A rule in `creating`
    must already hold matching actions, otherwise the very next purchase slips through."""
    ids = Identities.local()
    draft = RuleDraft(template="ask_category", params={"category": "drinks"}, text="Ask me before buying drinks.",
                      effect="ask_first", confidence=1.0)
    rule = draft_to_rule(draft, "hh_t", origin={"type": "default"}, now="2026-10-12T10:00:00+00:00", ids=ids)
    seeded.put_rule(rule.model_copy(update={"policy_status": "creating", "active": False, "policy_id": "p-creating"}))

    class CountingGateway(CedarFakeGateway):
        calls = 0

        def call(self, *a, **kw):
            CountingGateway.calls += 1
            return super().call(*a, **kw)

    gw = CountingGateway(seeded)
    out, _ = run(seeded, args=checkout(3100), gateway=gw)
    assert out.status == "held_for_approval" and CountingGateway.calls == 0
    assert out.receipt.authority.decision == "DENY" and out.receipt.authority.rule_ids == [rule.rule_id]
    assert out.denied_rule["rule_text"] == "Ask me before buying drinks."
    # other categories are unaffected
    ok, _ = run(seeded, args=checkout(1300, category="household"), gateway=gw)
    assert ok.status == "executed" and CountingGateway.calls == 1
