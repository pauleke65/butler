"""RunContext: everything one planner run needs (store, gateway, guard) plus the local tools (contracts §5.1)."""
from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from butler_actions import clock
from butler_actions.ids import new_id
from butler_actions.store import Store
from butler_contracts.models import (
    ActionDraft,
    Decision,
    DecisionOption,
    Money,
    Need,
    Plan,
    Preference,
    ReasonHeld,
)

from .guard import RunGuard, RunLimitExceeded

log = logging.getLogger("butler.agent")

TERMINAL = ("done", "needs_you", "blocked", "skipped")
DECISION_TTL = timedelta(hours=24)
ResultKind = Literal["executed", "ask", "never", "failed", "retry_blocked"]


@dataclass
class ActResult:
    kind: ResultKind
    text: str
    data: dict[str, Any] | None = None
    receipt: Any = None
    denied_rule: dict[str, Any] | None = None
    args: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.kind == "executed"


def _load_call_action() -> Callable[..., Any]:
    from butler_actions.wrapper import call_action

    return call_action


@dataclass
class RunContext:
    household_id: str
    plan_id: str
    correlation_id: str
    store: Store
    gateway: Any
    guard: RunGuard = field(default_factory=RunGuard)
    ids: Any = None
    call_action: Callable[..., Any] | None = None
    wrapper_guard: Any = None
    now: Callable[[], datetime] = clock.now
    finished_summary: str | None = None
    trace: list[ActResult] = field(default_factory=list)
    _counters: dict[tuple[str, str], int] = field(default_factory=dict)
    _open_denials: dict[str, ActResult] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.call_action is None and self.wrapper_guard is None:
            from butler_actions.wrapper import RunGuard as WrapperGuard

            self.wrapper_guard = WrapperGuard()

    # ── plan / need access ────────────────────────────────────────────
    def plan(self) -> Plan:
        plan = self.store.get_plan(self.household_id, self.plan_id)
        if plan is None:
            raise LookupError(f"plan {self.plan_id} not found")
        return plan

    def need(self, need_id: str) -> Need:
        need = self.store.get_need(self.plan_id, need_id)
        if need is None:
            raise LookupError(f"need {need_id} not found")
        return need

    def iso(self) -> str:
        return self.now().isoformat(timespec="seconds")

    def set_need(self, need_id: str, status: str, note: str | None = None, *, decision_id: str | None = None,
                 action_id: str | None = None) -> Need:
        need = self.need(need_id)
        update: dict[str, Any] = {"status": status, "updated_at": self.iso()}
        if note is not None:
            update["note"] = note[:200]
        if decision_id:
            update["decision_id"] = decision_id
        if action_id and action_id not in need.action_ids:
            update["action_ids"] = [*need.action_ids, action_id]
        updated = need.model_copy(update=update)
        self.store.put_need(updated)
        return updated

    # ── gateway actions (contracts §8 wrapper + §5.1 guard) ───────────
    def idempotency_key(self, need_id: str, tool: str) -> str:
        kind = tool.split("___")[-1]
        n = self._counters[(need_id, kind)] = self._counters.get((need_id, kind), 0) + 1
        return f"{self.plan_id}:{need_id}:{kind}:{n}"

    def act(self, tool: str, args: dict[str, Any], *, need_id: str,
            reasoning: dict[str, Any] | None = None) -> ActResult:
        """Call a Gateway tool as ``butler-agent``. Raises ``RunLimitExceeded`` at the step/time caps."""
        self.need(need_id)  # fail before any side effect if the need id is wrong
        self.guard.before_call()
        full = {**args, "plan_id": self.plan_id, "need_id": need_id, "correlation_id": self.correlation_id}
        full.setdefault("idempotency_key", self.idempotency_key(need_id, tool))
        if reasoning:
            full["reasoning"] = reasoning
        call = self.call_action or _load_call_action()
        extra = {"guard": self.wrapper_guard} if self.wrapper_guard is not None else {}
        outcome = call("butler-agent", tool, full, household_id=self.household_id, correlation_id=self.correlation_id,
                       plan_id=self.plan_id, need_id=need_id, decision_id=None, store=self.store,
                       gateway=self.gateway, ids=self.ids, **extra)
        result = self._interpret(tool, need_id, outcome, {k: v for k, v in full.items() if k != "reasoning"})
        self.trace.append(result)
        return result

    def _interpret(self, tool: str, need_id: str, outcome: Any, args: dict[str, Any]) -> ActResult:
        text = _outcome_text(outcome)
        receipt = outcome.receipt
        if receipt is not None:
            self.set_need(need_id, self.need(need_id).status, action_id=receipt.action_id)
        if (getattr(outcome, "error", None) or {}).get("code") == "DENIED_RETRY_BLOCKED":
            return ActResult("retry_blocked", text, None, receipt, outcome.denied_rule, args)
        if outcome.status == "executed":
            return ActResult("executed", text, outcome.data, receipt, None, args)
        if outcome.status in ("held_for_approval", "blocked"):
            rule = outcome.denied_rule
            kind: ResultKind = "never" if (rule and rule.get("effect") == "never") or outcome.status == "blocked" else "ask"
            result = ActResult(kind, text, outcome.data, receipt, rule, args)
            self._open_denials[need_id] = result
            return result
        return ActResult("failed", text, outcome.data, receipt, None, args)

    # ── local tools ───────────────────────────────────────────────────
    def get_household(self) -> dict[str, Any]:
        hh = self.store.get_household(self.household_id)
        return {
            "household": {"name": hh.name, "timezone": hh.timezone} if hh else {},
            "members": [{"name": m.get("name")} for m in self.store.list_members(self.household_id)],
            "contacts": [{"contact_id": c.contact_id, "name": c.name, "relationship": c.relationship, "tags": c.tags or []}
                         for c in self.store.list_contacts(self.household_id)],
        }

    def get_plan(self) -> dict[str, Any]:
        return json.loads(self.plan().model_dump_json(exclude_none=True))

    def list_rules(self) -> list[dict[str, str]]:
        return [{"rule_id": r.rule_id, "text": r.text, "effect": r.effect}
                for r in self.store.list_rules(self.household_id, active_only=True)]

    def update_need(self, need_id: str, status: str, note: str | None = None) -> dict[str, str]:
        if status not in ("doing", "done", "blocked", "skipped"):
            raise ValueError("status must be doing, done, blocked or skipped (use request_decision for needs_you)")
        self.set_need(need_id, status, note)
        return {"need_id": need_id, "status": status}

    def request_decision(self, need_id: str, kind: str, question: str, options: list[dict[str, Any]],
                         default_index: int | None = None, reason_held: dict[str, str] | None = None) -> Decision:
        need = self.need(need_id)
        built = [_build_option(o) for o in options]
        if kind == "choose_option" and not 2 <= len(built) <= 5:
            raise ValueError("choose_option needs 2 to 5 options")
        if kind == "approve_action" and (len(built) != 1 or built[0].action_draft is None):
            raise ValueError("approve_action needs exactly one option carrying an action_draft")
        if kind not in ("choose_option", "approve_action"):
            raise ValueError("kind must be choose_option or approve_action")
        now = self.now()
        decision = Decision(
            decision_id=new_id("dec"), plan_id=self.plan_id, need_id=need_id, kind=kind,  # type: ignore[arg-type]
            question=question, options=built,
            default_option_id=built[default_index].option_id if default_index is not None else None,
            reason_held=ReasonHeld(**reason_held) if reason_held else None, status="pending",
            created_at=now.isoformat(timespec="seconds"), expires_at=(now + DECISION_TTL).isoformat(timespec="seconds"))
        self.store.put_decision(self.household_id, decision)
        self.set_need(need.need_id, "needs_you", question, decision_id=decision.decision_id)
        self._open_denials.pop(need.need_id, None)
        return decision

    def get_preferences(self, keys: list[str] | None = None) -> dict[str, str]:
        prefs = {p.key: p.value for p in self.store.list_preferences(self.household_id)}
        return {k: v for k, v in prefs.items() if not keys or k in keys}

    def note_preference(self, key: str, value: str, evidence: str) -> Preference:
        existing = next((p for p in self.store.list_preferences(self.household_id) if p.key == key), None)
        learned = list(dict.fromkeys([*(existing.learned_from if existing and existing.value == value else []), evidence]))
        pref = Preference(key=key, value=value, learned_from=learned[-10:])
        self.store.put_preference(self.household_id, pref)
        return pref

    def finish(self, summary: str) -> dict[str, str]:
        self.finished_summary = summary
        return {"finished": "true"}

    # ── wrap-up ───────────────────────────────────────────────────────
    def resolve_open_denials(self) -> None:
        """Code-enforced loop rule 2: a denied need the model left hanging still gets its decision (ask_first) or
        is skipped (never), so a policy hold can never silently turn into a plain failure."""
        for need_id, res in list(self._open_denials.items()):
            need = self.store.get_need(self.plan_id, need_id)
            if need is None or need.status != "doing":
                continue
            rule = res.denied_rule or {}
            if res.kind == "ask" and rule.get("rule_id"):
                tool, args = res.receipt.action.tool, res.args
                summary, price = describe_action(tool, args)
                self.request_decision(
                    need_id, "approve_action", f"OK to go ahead? {summary}",
                    [{"title": summary, "price": {"amount_minor": price, "currency": "USD"} if price else None,
                      "tradeoff": f"Held because you said: {rule['rule_text']}", "simulated": True,
                      "action_draft": {"tool": tool, "args": args, "summary": summary}}],
                    reason_held={"rule_id": rule["rule_id"], "rule_text": rule["rule_text"]})
            elif res.kind == "never":
                self.set_need(need_id, "skipped", f"Not allowed by your rule: {rule.get('rule_text', 'a rule you set')}")


    def finalize(self, reason: str = "Something went wrong; ask me to try again.") -> Plan:
        """Guarantee no need is left ``doing`` and recompute the plan status."""
        self.resolve_open_denials()
        for need in self.store.list_needs(self.plan_id):
            if need.status == "doing":
                self.set_need(need.need_id, "blocked", reason)
        return self.refresh_plan_status()

    def refresh_plan_status(self) -> Plan:
        plan = self.plan()
        statuses = {n.status for n in plan.needs}
        if "needs_you" in statuses:
            status = "waiting_on_you"
        elif "doing" in statuses or "blocked" in statuses:
            status = "active"
        else:
            status = "complete"
        updated = plan.model_copy(update={"status": status, "updated_at": self.iso()})
        self.store.put_plan(updated)
        return updated

    def run_limit_reason(self) -> str:
        return "Ran out of time; ask me to try again."


def describe_action(tool: str, args: dict[str, Any]) -> tuple[str, int | None]:
    """A short human summary and price for an action draft the model did not describe itself."""
    price = args.get("amount_minor") if isinstance(args.get("amount_minor"), int) else None
    cost = f", {price // 100} dollars" if price and price % 100 == 0 else ""
    verbs = {"Supplies___checkout": f"Buy {args.get('category', 'items')}{cost}",
             "Services___book_service": f"Book {str(args.get('service_type', 'a service')).replace('_', ' ')}{cost}",
             "Messages___send_email": "Send that message", "Supplies___refund": "Refund the order"}
    return verbs.get(tool, tool.split("___")[-1].replace("_", " ").capitalize()), price


def _outcome_text(outcome: Any) -> str:
    try:
        from butler_actions.wrapper import agent_tool_text

        return agent_tool_text(outcome)
    except ImportError:  # pragma: no cover - wrapper not installed
        return str(outcome.status)


def _build_option(o: dict[str, Any]) -> DecisionOption:
    price = o.get("price")
    return DecisionOption(
        option_id=new_id("opt"), title=o["title"], subtitle=o.get("subtitle"),
        price=Money(amount_minor=price["amount_minor"], currency=price.get("currency", "USD")) if price else None,
        tradeoff=o.get("tradeoff", ""), simulated=o.get("simulated"),
        action_draft=ActionDraft(**o["action_draft"]) if o.get("action_draft") else None)


__all__ = ["TERMINAL", "ActResult", "RunContext", "RunLimitExceeded"]
