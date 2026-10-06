"""Action-call wrapper (contracts §8): the one place a tool call becomes a receipt.

Used by the agent (as ``butler-agent``) and the approval executor (as ``approval-executor``).
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from butler_contracts.models import Receipt, Rule
from butler_rules import Identities, PrincipalName, match, policy_field_problems

from . import clock
from .gateway import TRANSPORT_ERROR_CODES, GatewayClient, GatewayResponse, supports_household
from .ids import new_id
from .lint import lint_spoken
from .scoring import might_disagree
from .store import Store
from .summaries import READ_ONLY_TOOLS, receipt_title, spoken_summary

log = logging.getLogger("butler.wrapper")

UNDO_TOOLS: dict[str, str] = {
    "Supplies___checkout": "Supplies___refund",
    "Services___book_service": "Services___cancel_booking",
    "Calendar___create_event": "Calendar___delete_event",
}
SIMULATED_TARGETS = {"Supplies", "Services"}
COST_TOOLS = {"Supplies___checkout", "Services___book_service", "Supplies___refund"}
DENIED_RETRY_BLOCKED = "DENIED_RETRY_BLOCKED"
Status = Literal["executed", "held_for_approval", "blocked", "failed"]


@dataclass
class RunGuard:
    """Per-run state: blocks a second call of the same tool for the same need after a DENY."""

    denied: dict[tuple[str | None, str], dict[str, Any] | None] = field(default_factory=dict)
    calls: int = 0

    def blocked(self, need_id: str | None, tool: str) -> bool:
        return (need_id, tool) in self.denied

    def record_denial(self, need_id: str | None, tool: str, denied_rule: dict[str, Any] | None) -> None:
        self.denied[(need_id, tool)] = denied_rule


@dataclass
class ActionOutcome:
    status: Status
    receipt: Receipt
    data: dict[str, Any] | None = None
    denied_rule: dict[str, Any] | None = None  # {"rule_id","rule_text","effect"}
    error: dict[str, Any] | None = None  # {"code","message"} for failed / retry-blocked / invalid


def default_idempotency_key(plan_id: str | None, need_id: str | None, tool: str, args: dict[str, Any]) -> str:
    """`${plan_id}:${need_id}:${action_kind}:${n}` with n = a hash of the args (same call, same key)."""
    digest = hashlib.sha1(json.dumps(args, sort_keys=True, default=str).encode()).hexdigest()[:10]
    return f"{plan_id or 'noplan'}:{need_id or 'noneed'}:{tool.split('___', 1)[-1]}:{digest}"


def clean_reasoning(raw: Any) -> dict[str, Any]:
    """Model-written reasoning is untrusted: keep only well-formed strings so a receipt can always be written."""
    if not isinstance(raw, dict):
        return {}

    def strings(key: str) -> list[str]:
        v = raw.get(key)
        return [str(x) for x in v if isinstance(x, (str, int, float))] if isinstance(v, list) else []

    alts = [{"option": str(a["option"]), "rejected_because": str(a["rejected_because"])}
            for a in (raw.get("alternatives") or []) if isinstance(a, dict) and "option" in a and "rejected_because" in a]
    conf = raw.get("confidence")
    return {"reasons": strings("reasons"), "context_used": strings("context_used"), "alternatives": alts,
            "confidence": conf if isinstance(conf, (int, float)) and not isinstance(conf, bool) else None}


def _prepare_args(args: dict[str, Any], plan_id: str | None, need_id: str | None, correlation_id: str,
                  tool: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """(args sent to the Gateway, reasoning kept for the receipt)."""
    reasoning = clean_reasoning(args.get("reasoning"))
    sent = {k: v for k, v in args.items() if k != "reasoning" and v is not None}
    sent.setdefault("correlation_id", correlation_id)
    for k, v in (("plan_id", plan_id), ("need_id", need_id)):
        if v is not None:
            sent.setdefault(k, v)
    sent.setdefault("idempotency_key", default_idempotency_key(plan_id, need_id, tool, sent))
    return sent, reasoning


def _denied_rule(result: Any) -> dict[str, Any] | None:
    """The rule to blame: a `never` rule outranks ask_first."""
    if not result.rule_ids:
        return None
    pick = result.effects.index("never") if "never" in result.effects else 0
    return {"rule_id": result.rule_ids[pick], "rule_text": result.rule_texts[pick], "effect": result.effects[pick]}


def _gateway_decision(resp: GatewayResponse | None) -> str | None:
    """ALLOW / DENY as the Gateway decided; None when the Gateway could not decide (transport failure)."""
    if resp is None:
        return None
    if resp.status == "denied":
        return "DENY"
    if resp.status == "ok":
        return "ALLOW"
    code = (resp.error or {}).get("code")
    return None if code in TRANSPORT_ERROR_CODES else "ALLOW"


def _call_gateway(gateway: GatewayClient, principal: PrincipalName, tool: str, args: dict[str, Any],
                  household_id: str) -> GatewayResponse:
    try:
        if supports_household(gateway):
            return gateway.call(principal, tool, args, household_id=household_id)  # type: ignore[call-arg]
        return gateway.call(principal, tool, args)
    except Exception as exc:
        log.exception("gateway call raised")
        return GatewayResponse("error", None, {"code": "UPSTREAM_UNAVAILABLE", "message": str(exc)})


def _status_for(resp: GatewayResponse, denied: dict[str, Any] | None) -> Status:
    if resp.status == "ok":
        return "executed"
    if resp.status == "denied":
        return "held_for_approval" if denied and denied["effect"] == "ask_first" else "blocked"
    return "failed"


def _simulated(tool: str, data: dict[str, Any] | None) -> bool:
    if data and (data.get("simulated") or data.get("simulated_merchant")):
        return True
    return tool.split("___", 1)[0] in SIMULATED_TARGETS


def _cost(tool: str, args: dict[str, Any], data: dict[str, Any] | None) -> dict[str, Any] | None:
    if tool not in COST_TOOLS:
        return None
    amount = (data or {}).get("amount_minor", args.get("amount_minor"))
    return {"amount_minor": amount, "currency": "USD"} if type(amount) is int else None


def _reversible(tool: str, status: str, data: dict[str, Any] | None) -> bool:
    return status == "executed" and tool in UNDO_TOOLS and bool(data)


def _plan_labels(store: Store, household_id: str, plan_id: str | None, need_id: str | None) -> dict[str, Any]:
    if not plan_id:
        return {}
    try:
        plan = store.get_plan(household_id, plan_id)
    except Exception:  # noqa: BLE001 - labels are best effort
        return {}
    if not plan:
        return {}
    need = next((n for n in plan.needs if n.need_id == need_id), None)
    return {"situation": plan.situation, "need_label": need.label if need else None}


def _allowing(rules: list[Rule], tool: str, args: dict[str, Any]) -> list[Rule]:
    """Spend-limit rules that an allowed call fell inside ("Your 50 dollar limit allowed it.")."""
    amount = args.get("amount_minor")
    out = []
    for r in rules:
        if not (r.active and r.template == "spend_cap" and tool in r.params.get("tools", [])):
            continue
        if isinstance(amount, int) and not isinstance(amount, bool) and amount <= int(r.params.get("cap_minor", 0)):
            out.append(r)
    return out


@dataclass
class _Call:
    """Everything known about one call while its receipt is being built."""

    principal: PrincipalName
    tool: str
    sent: dict[str, Any]
    reasoning: dict[str, Any]
    household_id: str
    correlation_id: str
    plan_id: str | None
    need_id: str | None
    decision_id: str | None
    store: Store
    rules: list[Rule]
    undo_of: str | None


def call_action(principal: PrincipalName, tool: str, args: dict[str, Any], *, household_id: str,
                correlation_id: str, plan_id: str | None = None, need_id: str | None = None,
                decision_id: str | None = None, store: Store, gateway: GatewayClient,
                rules: list[Rule] | None = None, ids: Identities | None = None, guard: RunGuard | None = None,
                undo_of: str | None = None) -> ActionOutcome:
    """Run one Gateway tool call and ALWAYS write a receipt (contracts §8). ``ids`` is reserved."""
    sent, reasoning = _prepare_args(args, plan_id, need_id, correlation_id, tool)
    rules = store.list_rules(household_id, active_only=True) if rules is None else rules
    call = _Call(principal, tool, sent, reasoning, household_id, correlation_id, plan_id, need_id, decision_id,
                 store, rules, undo_of)
    expected = match(rules, principal, tool, sent)
    if guard is not None:
        guard.calls += 1
        if guard.blocked(need_id, tool):
            blame = guard.denied[(need_id, tool)] or _denied_rule(expected)
            err = {"code": DENIED_RETRY_BLOCKED, "message": "already denied for this need in this run"}
            return _finish(call, None, expected, "blocked", "DENY", blame, err)
    problems = policy_field_problems(sent, tool)
    if problems:  # fail closed: Cedar would skip a forbid it cannot evaluate (see butler_rules.inputs)
        err = {"code": "INVALID_INPUT", "message": "; ".join(problems)}
        return _finish(call, None, expected, "failed", None, None, err)
    resp = _call_gateway(gateway, principal, tool, sent, household_id)
    blame = _denied_rule(expected) if resp.status == "denied" else None
    status = _status_for(resp, blame)
    if status in ("held_for_approval", "blocked") and guard is not None:
        guard.record_denial(need_id, tool, blame)
    return _finish(call, resp, expected, status, _gateway_decision(resp), blame, resp.error if status == "failed" else None)


def _finish(call: _Call, resp: GatewayResponse | None, expected: Any, status: Status, actual: str | None,
            blame: dict[str, Any] | None, error: dict[str, Any] | None) -> ActionOutcome:
    """Compare matcher and gateway, build and store the receipt, return the outcome."""
    retry_blocked = bool(error and error["code"] == DENIED_RETRY_BLOCKED)
    agree = retry_blocked or actual is None or actual == expected.decision
    if not agree:
        log.error("PARITY_MISMATCH tool=%s principal=%s matcher=%s gateway=%s rule_ids=%s correlation_id=%s",
                  call.tool, call.principal, expected.decision, actual, expected.rule_ids, call.correlation_id)
    decision = actual or expected.decision
    data = resp.data if resp and resp.status == "ok" else None
    receipt = _build_receipt(call, status, decision, agree, expected, blame, resp, data, error)
    call.store.put_receipt(receipt)
    return ActionOutcome(status, receipt, data, blame, error)


def _build_receipt(call: _Call, status: Status, decision: str, agree: bool, matched: Any,
                   blame: dict[str, Any] | None, resp: GatewayResponse | None, data: dict[str, Any] | None,
                   error: dict[str, Any] | None) -> Receipt:
    now = clock.now()
    tool, sent = call.tool, call.sent
    rule_ids = [blame["rule_id"]] if blame else list(matched.rule_ids)
    rule_texts = [blame["rule_text"]] if blame else list(matched.rule_texts)
    if status == "executed" and not blame and call.principal == "butler-agent":
        allowing = _allowing(call.rules, tool, sent)
        rule_ids, rule_texts = [r.rule_id for r in allowing], [r.text for r in allowing]
    summary_rules = rule_texts
    reasons = [str(r) for r in (call.reasoning.get("reasons") or [])][:3]
    spoken = spoken_summary(tool, status, sent, data, reasons, summary_rules, approved=call.decision_id is not None,
                            error=error, now=now)
    if problems := lint_spoken(spoken):
        log.warning("spoken_summary lint: %s -> %s", spoken, problems)
    score = (might_disagree(call.store, call.household_id, tool, sent, call.reasoning, now) if status == "executed"
             else {"score": 0.0, "top_reason": None})
    return Receipt(
        action_id=new_id("act"), household_id=call.household_id, plan_id=call.plan_id, need_id=call.need_id,
        decision_id=call.decision_id, correlation_id=call.correlation_id,
        **_plan_labels(call.store, call.household_id, call.plan_id, call.need_id),
        action={"tool": tool, "args": sent}, title=receipt_title(tool, status, sent), status=status,
        reasons=reasons, context_used=[str(c) for c in (call.reasoning.get("context_used") or [])],
        alternatives=[a for a in (call.reasoning.get("alternatives") or []) if isinstance(a, dict)][:3],
        authority={"decision": decision, "principal": call.principal, "rule_ids": rule_ids, "rule_texts": rule_texts,
                   "gateway_request_id": resp.request_id if resp else None, "evaluated_at": clock.iso(now),
                   "matcher_gateway_agree": agree},
        cost=_cost(tool, sent, data), result=data, reversible=_reversible(tool, status, data), undo_of=call.undo_of,
        might_disagree=score, simulated=_simulated(tool, data), spoken_summary=spoken, created_at=clock.iso(now),
    )


def agent_tool_text(outcome: ActionOutcome) -> str:
    """What the planner model sees: ``EXECUTED: …`` / ``DENIED by rule "…" (ask_first)`` / ``FAILED: …``."""
    r = outcome.receipt
    err = outcome.error or {}
    if err.get("code") == DENIED_RETRY_BLOCKED:
        rule = outcome.denied_rule
        why = f' by rule "{rule["rule_text"]}" ({rule["effect"]})' if rule else ""
        return (f"DENIED_RETRY_BLOCKED: {r.action.tool} was already denied{why} for this need. "
                "Do not retry; use request_decision or skip the need.")
    if outcome.status == "executed":
        payload = json.dumps(outcome.data or {}, default=str)[:6000]
        read_only = " (read only)" if r.action.tool in READ_ONLY_TOOLS else ""
        return f"EXECUTED: {r.title}{read_only}. action_id={r.action_id} data={payload}"
    if outcome.status in ("held_for_approval", "blocked"):
        rule = outcome.denied_rule
        if rule:
            hint = ("Ask the customer with request_decision (approve_action)." if rule["effect"] == "ask_first"
                    else "Do not retry; mark the need skipped and say which rule blocked it.")
            return f'DENIED by rule "{rule["rule_text"]}" ({rule["effect"]}). {hint}'
        return "DENIED by policy (no matching rule found). Do not retry."
    msg = (outcome.error or {}).get("message", "unknown error")
    return f"FAILED: {(outcome.error or {}).get('code', 'INTERNAL')}: {msg}"
