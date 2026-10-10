"""draft_rule / apply_rule / remove_rule (contracts §5): validation, storage and policy lifecycle."""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

from butler_actions import clock
from butler_actions.store import Store
from butler_contracts.models import Rule
from butler_rules import (
    Identities,
    PolicyError,
    PolicyPropagatingError,
    PolicyService,
    RuleParamError,
    draft_to_rule,
    validate_params,
)

from .config import RULE_CONFIDENCE_THRESHOLD
from .drafter import SUPPORTED_SENTENCE, DraftContext, RuleDrafter

log = logging.getLogger("butler.rules")


def _err(code: str, message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "error": {"code": code, "message": message}}
    if data:
        out["data"] = data
    return out


def _dump(model: Any) -> dict[str, Any]:
    return model.model_dump(mode="json", exclude_none=True)


class RuleOps:
    def __init__(self, store: Store, drafter: RuleDrafter, policy: PolicyService, ids: Identities | None = None,
                 settle_ms: int | None = None):
        self.store, self.drafter, self.policy = store, drafter, policy
        self.ids = ids or Identities.from_env()
        # A policy can be ACTIVE before the gateway enforces it. We only tell the customer a rule is in
        # force after this settle window, otherwise the very next action can slip through (found in the
        # first full-stack golden run). Tune from the measured propagation time (spike S-1).
        self.settle_ms = int(os.environ.get("POLICY_SETTLE_MS", "1500")) if settle_ms is None else settle_ms

    # ── draft_rule ────────────────────────────────────────────────────
    def draft_rule(self, req: dict[str, Any]) -> dict[str, Any]:
        hh, correction = req["household_id"], req["correction"]
        base = self.store.get_rule(hh, req["base_rule_id"]) if req.get("base_rule_id") else None
        if req.get("base_rule_id") and base is None:
            return _err("NOT_FOUND", f"Rule {req['base_rule_id']} not found.")
        receipt = self.store.get_receipt(hh, req["action_id"]) if req.get("action_id") else None
        ctx = DraftContext(self.store.list_contacts(hh), self.store.list_rules(hh, active_only=True), receipt, base)
        draft = self.drafter.draft(correction, ctx)
        if draft.template == "unsupported" or draft.confidence < RULE_CONFIDENCE_THRESHOLD:
            return _err("RULE_UNSUPPORTED", SUPPORTED_SENTENCE)
        try:
            validate_params(draft.template, draft.params)
            rule = draft_to_rule(
                draft, hh, now=clock.iso(), ids=self.ids,
                origin={"type": "correction", "utterance": correction, "action_id": req.get("action_id"),
                        "created_at": clock.iso()})
        except RuleParamError as e:
            log.info("draft rejected: %s", e)
            return _err("RULE_UNSUPPORTED", SUPPORTED_SENTENCE)
        self.store.put_rule(rule)
        self.store.set_latest_draft(hh, rule.rule_id)
        if base is not None:
            self.store.put_record(hh, "rulechange", rule.rule_id, {"replaces": base.rule_id})
        return {"ok": True, "data": {"draft": _dump(draft), "rule": _dump(rule)}}

    # ── apply_rule ────────────────────────────────────────────────────
    def apply_rule(self, req: dict[str, Any]) -> dict[str, Any]:
        hh = req["household_id"]
        rule = self.store.get_rule(hh, req["rule_id"])
        if rule is None:
            return _err("NOT_FOUND", f"Rule {req['rule_id']} not found.")
        if rule.active and rule.policy_status == "active":
            return {"ok": True, "data": {"rule": _dump(rule)}}
        try:
            created = self.policy.create(rule)
        except PolicyPropagatingError as e:
            # Still activating on AgentCore. The wrapper already honours `creating` rules, so the customer can be
            # told it is done; finish the activation (and any replacement) in the background.
            self.store.put_rule(e.rule)
            self._finish_later(hh, e.rule)
            return _err("POLICY_PROPAGATING", "The rule was created and is taking effect.", {"rule": _dump(e.rule)})
        except PolicyError as e:
            log.error("policy create failed: %s", e)
            failed = rule.model_copy(update={"policy_status": "failed", "active": False, "updated_at": clock.iso()})
            self.store.put_rule(failed)
            return _err(e.code, str(e), {"rule": _dump(failed)})
        self._settle()
        self.store.put_rule(created)
        self._disable_replaced(hh, created)
        return {"ok": True, "data": {"rule": _dump(created)}}

    def _finish_later(self, hh: str, rule: Rule) -> threading.Thread | None:
        finish = getattr(self.policy, "finish", None)
        if finish is None:
            return None

        def run() -> None:
            try:
                active = finish(rule)
                self._settle()
                self.store.put_rule(active)
                self._disable_replaced(hh, active)
                log.info("rule %s active (background)", rule.rule_id)
            except Exception:  # noqa: BLE001 - background thread: log and leave the rule `creating`/`failed`
                log.exception("background activation failed for rule %s", rule.rule_id)

        t = threading.Thread(target=run, name=f"activate-{rule.rule_id}", daemon=True)
        t.start()
        return t

    def _settle(self) -> None:
        if self.settle_ms > 0:
            time.sleep(self.settle_ms / 1000)

    def _disable_replaced(self, hh: str, new: Rule) -> None:
        """Old rule goes only after the new one is active (no gap, contracts §3.9)."""
        change = self.store.get_record(hh, "rulechange", new.rule_id)
        old = self.store.get_rule(hh, change["replaces"]) if change else None
        if old is not None and old.active:
            self.store.put_rule(self.policy.disable(old))

    # ── remove_rule ───────────────────────────────────────────────────
    def remove_rule(self, req: dict[str, Any]) -> dict[str, Any]:
        hh = req["household_id"]
        rule = self.store.get_rule(hh, req["rule_id"])
        if rule is None:
            return _err("NOT_FOUND", f"Rule {req['rule_id']} not found.")
        try:
            disabled = self.policy.disable(rule)
        except PolicyError as e:
            return _err(e.code, str(e))
        self._settle()
        self.store.put_rule(disabled)
        return {"ok": True, "data": {"rule": _dump(disabled)}}
