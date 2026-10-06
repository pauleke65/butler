"""The agent: ops router (contracts §5) over a bundle of injected services."""
from __future__ import annotations

import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from butler_actions.store import Store
from butler_contracts import models as m
from butler_rules import Identities, PolicyService
from pydantic import ValidationError

from .context import RunContext
from .drafter import RuleDrafter
from .learning import learn_from_decision
from .planner import Planner
from .rule_ops import RuleOps
from .runner import BackgroundRunner

log = logging.getLogger("butler.agent")

REQUEST_MODELS: dict[str, type[Any]] = {
    "start_plan": m.AgentRequest1, "resume_plan": m.AgentRequest2, "draft_rule": m.AgentRequest3,
    "apply_rule": m.AgentRequest4, "remove_rule": m.AgentRequest5,
}
ASYNC_OPS = frozenset({"start_plan", "resume_plan"})


@dataclass
class Services:
    store: Store
    gateway: Any
    planner: Planner
    drafter: RuleDrafter
    policy: PolicyService
    ids: Identities
    store_factory: Callable[[], Store] | None = None  # fresh Store per background run (real AWS)
    call_action: Callable[..., Any] | None = None  # test seam; default is butler_actions.wrapper.call_action


def error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


class Agent:
    def __init__(self, services: Services, runner: BackgroundRunner | None = None):
        self.s = services
        self.runner = runner or BackgroundRunner()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _plan_lock(self, plan_id: str) -> threading.Lock:
        """Runs on the same plan are serialised in-process (a retried start_plan must not race itself)."""
        with self._locks_guard:
            return self._locks.setdefault(plan_id, threading.Lock())

    def handle(self, request: dict[str, Any], *, run_async: bool = False) -> dict[str, Any]:
        op = request.get("op")
        model = REQUEST_MODELS.get(str(op))
        if model is None:
            return error("INVALID_INPUT", f"Unknown op: {op!r}")
        try:
            req = model.model_validate(request).model_dump(exclude_none=True)
        except ValidationError as e:
            return error("INVALID_INPUT", "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors()[:4]))
        try:
            if op in ASYNC_OPS:
                return self._plan_op(op, req, run_async)  # type: ignore[arg-type]
            ops = RuleOps(self.s.store, self.s.drafter, self.s.policy, self.s.ids)
            return getattr(ops, str(op))(req)
        except Exception:
            log.exception("op %s failed (correlation_id=%s)", op, req.get("correlation_id"))
            return error("INTERNAL", "Something went wrong on my side.")

    # ── async plan ops ────────────────────────────────────────────────
    def _plan_op(self, op: str, req: dict[str, Any], run_async: bool) -> dict[str, Any]:
        if self.s.store.get_plan(req["household_id"], req["plan_id"]) is None:
            return error("NOT_FOUND", f"Plan {req['plan_id']} not found.")
        work = self.start_plan if op == "start_plan" else self.resume_plan
        if run_async:
            self.runner.submit(lambda: work(req))
        else:
            work(req)
        return {"ok": True, "data": {"accepted": True}}

    def _context(self, req: dict[str, Any]) -> RunContext:
        store = self.s.store_factory() if self.s.store_factory else self.s.store
        return RunContext(req["household_id"], req["plan_id"], req.get("correlation_id") or f"cor_{uuid.uuid4().hex[:12]}",
                          store, self.s.gateway, ids=self.s.ids, call_action=self.s.call_action)

    def start_plan(self, req: dict[str, Any]) -> None:
        ctx = self._context(req)
        log.info("start_plan plan=%s correlation_id=%s", ctx.plan_id, ctx.correlation_id)
        with self._plan_lock(ctx.plan_id):
            try:
                self.s.planner.run(ctx)
            except Exception:
                log.exception("planner crashed plan=%s", ctx.plan_id)
                ctx.finalize("Something went wrong; ask me to try again.")
            ctx.refresh_plan_status()

    def resume_plan(self, req: dict[str, Any]) -> None:
        ctx = self._context(req)
        log.info("resume_plan plan=%s decision=%s correlation_id=%s", ctx.plan_id, req["decision_id"], ctx.correlation_id)
        with self._plan_lock(ctx.plan_id):
            decision = ctx.store.get_decision(ctx.plan_id, req["decision_id"])
            try:
                if decision is not None:
                    self._settle_decision(ctx, decision)
                    learn_from_decision(ctx, decision)
                self.s.planner.run(ctx)  # picks up any need still "doing"
            except Exception:
                log.exception("resume crashed plan=%s", ctx.plan_id)
                ctx.finalize("Something went wrong; ask me to try again.")
            ctx.refresh_plan_status()

    @staticmethod
    def _settle_decision(ctx: RunContext, decision: m.Decision) -> None:
        """Make the affected need match the decision's outcome if the executor/server didn't already."""
        need = ctx.store.get_need(ctx.plan_id, decision.need_id)
        if need is None or need.status != "needs_you":
            return
        outcomes = {"executed": ("done", "Done."), "rejected": ("skipped", "You said no."),
                    "failed": ("blocked", "That didn't go through."), "expired": ("skipped", "The question expired.")}
        if decision.status in outcomes:
            status, note = outcomes[decision.status]
            ctx.set_need(need.need_id, status, note)
