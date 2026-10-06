"""Approval executor (contracts §6): deterministic, no model calls, runs approved decisions and undos."""
from __future__ import annotations

import logging
import os
from typing import Any

from butler_actions import clock
from butler_actions.gateway import CognitoClientCredentials, GatewayClient, HttpGatewayClient
from butler_actions.store import Store
from butler_actions.wrapper import UNDO_TOOLS, ActionOutcome, call_action
from butler_contracts.models import Decision, ExecutorRequest1, ExecutorRequest2, Need, Receipt
from pydantic import ValidationError

log = logging.getLogger("butler.executor")

PRINCIPAL = "approval-executor"
NEVER_MESSAGE = "Your rule says never to do that, so I didn't."
UNDO_ID_FIELD = {"Supplies___refund": ("order_id", "order_id"), "Services___cancel_booking": ("booking_id", "booking_id"),
                 "Calendar___delete_event": ("event_id", "event_id")}


def _err(code: str, message: str, **data: Any) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if data:
        out["data"] = data
    return out


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=True)


def default_gateway() -> GatewayClient:
    """Local static tokens, or Cognito client credentials when COGNITO_TOKEN_URL is set (AWS)."""
    token_url = os.environ.get("COGNITO_TOKEN_URL")
    if not token_url:
        return HttpGatewayClient.from_env()
    cred = CognitoClientCredentials(token_url, os.environ["EXECUTOR_CLIENT_ID"], os.environ["EXECUTOR_CLIENT_SECRET"],
                                    os.environ.get("EXECUTOR_SCOPE"))
    return HttpGatewayClient(os.environ["GATEWAY_URL"], {"approval-executor": cred, "butler-agent": cred})


def handler(event: dict[str, Any], context: Any = None, *, store: Store | None = None,
            gateway: GatewayClient | None = None) -> dict[str, Any]:
    """Lambda-style entry point: ExecutorRequest in, ``{ok, data | error}`` out. Store/gateway injectable."""
    store = store or Store()
    gateway = gateway or default_gateway()
    try:
        if event.get("mode") == "decision":
            return _run_decision(ExecutorRequest1(**event), store, gateway)
        if event.get("mode") == "undo":
            return _run_undo(ExecutorRequest2(**event), store, gateway)
    except ValidationError as exc:
        return _err("INVALID_INPUT", f"bad executor request: {exc.errors()[0]['msg']}")
    except Exception as exc:
        log.exception("executor failed correlation_id=%s", event.get("correlation_id"))
        return _err("INTERNAL", f"executor error: {type(exc).__name__}")
    return _err("INVALID_INPUT", "mode must be 'decision' or 'undo'")


# ── decision mode ─────────────────────────────────────────────────────────
def _update_need(store: Store, plan_id: str, need_id: str, status: str, note: str, action_id: str | None) -> None:
    need = store.get_need(plan_id, need_id)
    if need is None:
        return
    ids = [*need.action_ids, action_id] if action_id and action_id not in need.action_ids else need.action_ids
    store.put_need(Need(**{**need.model_dump(), "status": status, "note": note[:120], "action_ids": ids,
                           "updated_at": clock.iso()}))


def _finish_decision(store: Store, req: ExecutorRequest1, dec: Decision, outcome: ActionOutcome) -> dict[str, Any]:
    receipt = outcome.receipt
    if outcome.status == "executed":
        done = store.transition_decision(req.household_id, dec.plan_id, dec.decision_id, "approved", "executed",
                                         result_action_id=receipt.action_id)
        _update_need(store, dec.plan_id, dec.need_id, "done", f"{receipt.title} (you approved it)", receipt.action_id)
        return {"ok": True, "data": {"decision": _dump(done or dec), "receipt": _dump(receipt)}}
    failed = store.transition_decision(req.household_id, dec.plan_id, dec.decision_id, "approved", "failed",
                                       result_action_id=receipt.action_id)
    payload = {"decision": _dump(failed or dec), "receipt": _dump(receipt)}
    rule = outcome.denied_rule
    if rule and rule["effect"] == "never":
        _update_need(store, dec.plan_id, dec.need_id, "skipped", f"Not allowed by your rule: {rule['rule_text']}",
                     receipt.action_id)
        return _err("BLOCKED_BY_NEVER_RULE", NEVER_MESSAGE, **payload)
    _update_need(store, dec.plan_id, dec.need_id, "blocked", "I couldn't finish that after you approved it.",
                 receipt.action_id)
    code = (outcome.error or {}).get("code", "INTERNAL")
    code = code if code in ("UPSTREAM_UNAVAILABLE", "INVALID_INPUT") else "INTERNAL"
    return _err(code, (outcome.error or {}).get("message", "policy denied the approved action"), **payload)


def _replay(store: Store, req: ExecutorRequest1, dec: Decision) -> dict[str, Any] | None:
    """Approving an already-executed decision returns the original result instead of running it again."""
    if dec.status == "executed" and dec.result_action_id:
        receipt = store.get_receipt(req.household_id, dec.result_action_id)
        if receipt:
            return {"ok": True, "data": {"decision": _dump(dec), "receipt": _dump(receipt), "replayed": True}}
    return None


def _run_decision(req: ExecutorRequest1, store: Store, gateway: GatewayClient) -> dict[str, Any]:
    dec = store.find_decision(req.household_id, req.decision_id)
    if dec is None:
        return _err("NOT_FOUND", "I couldn't find that one.")
    if (replay := _replay(store, req, dec)) is not None:
        return replay
    if dec.status != "pending":
        return _err("INVALID_INPUT", f"decision is already {dec.status}")
    option = next((o for o in dec.options if o.option_id == req.option_id), None)
    if option is None or option.action_draft is None:
        return _err("INVALID_INPUT", "that option has nothing to run")
    approved = store.transition_decision(req.household_id, dec.plan_id, dec.decision_id, "pending", "approved",
                                         chosen_option_id=option.option_id)
    if approved is None:  # somebody else got there first: execute at most once
        return _err("INVALID_INPUT", "decision is already being handled")
    draft = option.action_draft
    log.info("executing approved decision=%s tool=%s correlation_id=%s", dec.decision_id, draft.tool, req.correlation_id)
    outcome = call_action(PRINCIPAL, draft.tool, dict(draft.args), household_id=req.household_id,  # type: ignore[arg-type]
                          correlation_id=req.correlation_id, plan_id=dec.plan_id, need_id=dec.need_id,
                          decision_id=dec.decision_id, store=store, gateway=gateway)
    return _finish_decision(store, req, approved, outcome)


# ── undo mode ─────────────────────────────────────────────────────────────
def _undo_call(orig: Receipt) -> tuple[str, dict[str, Any]] | None:
    """(undo tool, args) for a reversible receipt, or None."""
    undo_tool = UNDO_TOOLS.get(orig.action.tool)
    if undo_tool is None or orig.status != "executed":
        return None
    field, result_key = UNDO_ID_FIELD[undo_tool]
    ref = (orig.result or {}).get(result_key)
    if not ref:
        return None
    args: dict[str, Any] = {field: ref, "idempotency_key": f"undo:{orig.action_id}"}
    if undo_tool == "Calendar___delete_event":
        args["event_owner"] = "butler"
    return undo_tool, args


def _not_reversible(orig: Receipt) -> dict[str, Any]:
    if orig.action.tool == "Messages___send_email":
        return _err("NOT_REVERSIBLE", "I can't undo an email once it's sent.")
    if orig.status == "undone":
        return _err("NOT_REVERSIBLE", "That one has already been undone.")
    return _err("NOT_REVERSIBLE", "I can't undo that one.")


def _run_undo(req: ExecutorRequest2, store: Store, gateway: GatewayClient) -> dict[str, Any]:
    orig = store.get_receipt(req.household_id, req.action_id)
    if orig is None:
        return _err("NOT_FOUND", "I couldn't find that one.")
    plan = _undo_call(orig)
    if plan is None:
        return _not_reversible(orig)
    tool, args = plan
    outcome = call_action(PRINCIPAL, tool, args, household_id=req.household_id, correlation_id=req.correlation_id,  # type: ignore[arg-type]
                          plan_id=orig.plan_id, need_id=orig.need_id, store=store, gateway=gateway,
                          undo_of=orig.action_id)
    if outcome.status != "executed":
        rule = outcome.denied_rule
        if rule and rule["effect"] == "never":
            return _err("BLOCKED_BY_NEVER_RULE", NEVER_MESSAGE, undo=_dump(outcome.receipt))
        code = (outcome.error or {}).get("code", "INTERNAL")
        code = code if code in ("UPSTREAM_UNAVAILABLE", "INVALID_INPUT") else "INTERNAL"
        return _err(code, (outcome.error or {}).get("message", "undo was not allowed"), undo=_dump(outcome.receipt))
    undone = orig.model_copy(update={"status": "undone", "reversible": False})
    store.put_receipt(undone)
    return {"ok": True, "data": {"original": _dump(undone), "undo": _dump(outcome.receipt)}}
