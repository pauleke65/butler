"""Policy service (contracts §5 apply_rule / remove_rule): local and AgentCore implementations."""
from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from butler_contracts.models import Rule

from .compiler import compile_rule
from .identities import Identities

log = logging.getLogger("butler.policy")


class PolicyError(RuntimeError):
    """create/disable failed; ``code`` follows contracts §14 where one applies."""

    def __init__(self, message: str, code: str = "INTERNAL"):
        super().__init__(message)
        self.code = code


class PolicyPropagatingError(PolicyError):
    """The policy was created but is not ACTIVE yet (POLICY_PROPAGATING); ``rule`` is in ``creating``."""

    def __init__(self, rule: Rule):
        super().__init__(f"policy for {rule.rule_id} not active yet", "POLICY_PROPAGATING")
        self.rule = rule


class PolicyService(Protocol):
    def create(self, rule: Rule) -> Rule: ...
    def disable(self, rule: Rule) -> Rule: ...


def replace(service: PolicyService, old: Rule, new: Rule) -> Rule:
    """Create the new policy first, then disable the old one, so there is no gap (contracts §3.9)."""
    created = service.create(new)
    service.disable(old)
    return created


def _utc_now() -> datetime:
    return datetime.now(UTC)


class LocalPolicyService:
    """Activates rules in the local Store after a short simulated delay (no AWS)."""

    def __init__(self, store: Any, *, ids: Identities | None = None, activation_delay_ms: int = 0,
                 clock: Callable[[], datetime] = _utc_now, sleep: Callable[[float], None] = time.sleep):
        self.store, self.ids = store, ids or Identities.local()
        self.delay_ms, self.clock, self._sleep = activation_delay_ms, clock, sleep

    def _stamp(self) -> str:
        return self.clock().isoformat(timespec="milliseconds")

    def create(self, rule: Rule) -> Rule:
        if self.delay_ms:
            self._sleep(self.delay_ms / 1000)
        stmt = rule.cedar_statement or compile_rule(rule, self.ids)
        out = rule.model_copy(update={"cedar_statement": stmt, "policy_id": f"local-{rule.rule_id}",
                                      "policy_status": "active", "active": True, "updated_at": self._stamp()})
        self.store.put_rule(out)
        log.info("policy active rule=%s", rule.rule_id)
        return out

    def disable(self, rule: Rule) -> Rule:
        out = rule.model_copy(update={"policy_status": "disabled", "active": False, "updated_at": self._stamp()})
        self.store.put_rule(out)
        log.info("policy disabled rule=%s", rule.rule_id)
        return out


def policy_name(rule_id: str) -> str:
    """AgentCore policy names: ``[A-Za-z][A-Za-z0-9_]*``, at most 48 characters."""
    name = re.sub(r"[^A-Za-z0-9_]", "_", rule_id)
    return (name if name[:1].isalpha() else "p" + name)[:48]


class AgentCorePolicyService:
    """boto3 ``bedrock-agentcore-control`` create_policy / get_policy / delete_policy.

    Written from the AWS samples; it cannot run offline, so tests use botocore Stubber only.
    """

    def __init__(self, client: Any, policy_engine_id: str, *, store: Any | None = None,
                 poll_interval: float = 2.0, timeout: float = 60.0,
                 validation_mode: str = "FAIL_ON_ANY_FINDINGS",
                 sleep: Callable[[float], None] = time.sleep, monotonic: Callable[[], float] = time.monotonic):
        self.client, self.engine_id, self.store = client, policy_engine_id, store
        self.poll_interval, self.timeout, self.validation_mode = poll_interval, timeout, validation_mode
        self._sleep, self._mono = sleep, monotonic

    def _save(self, rule: Rule) -> Rule:
        if self.store is not None:
            self.store.put_rule(rule)
        return rule

    def _find_by_name(self, name: str) -> dict[str, Any] | None:
        token: str | None = None
        while True:
            kw: dict[str, Any] = {"policyEngineId": self.engine_id, **({"nextToken": token} if token else {})}
            res = self.client.list_policies(**kw)
            for p in res.get("policies", []):
                if p.get("name") == name:
                    return p
            token = res.get("nextToken")
            if not token:
                return None

    def _create_or_reuse(self, rule: Rule) -> dict[str, Any]:
        name = policy_name(rule.rule_id)
        try:
            return self.client.create_policy(
                name=name, policyEngineId=self.engine_id, description=rule.text[:200],
                definition={"cedar": {"statement": rule.cedar_statement}}, validationMode=self.validation_mode)
        except self.client.exceptions.ConflictException:
            existing = self._find_by_name(name)
            if existing is None:
                raise
            return existing

    def _wait_active(self, policy_id: str) -> tuple[str, list[Any]]:
        deadline = self._mono() + self.timeout
        delay = self.poll_interval
        while True:
            got = self.client.get_policy(policyEngineId=self.engine_id, policyId=policy_id)
            status = got["status"]
            if status in ("ACTIVE", "CREATE_FAILED", "UPDATE_FAILED"):
                return status, got.get("statusReasons", [])
            if self._mono() >= deadline:
                return status, got.get("statusReasons", [])
            self._sleep(delay)
            delay = min(delay * 1.5, 8.0)

    def create(self, rule: Rule) -> Rule:
        if not rule.cedar_statement:
            raise PolicyError("rule has no compiled Cedar statement", "INVALID_INPUT")
        started = self._mono()
        created = self._create_or_reuse(rule)
        policy_id = created["policyId"]
        creating = rule.model_copy(update={"policy_id": policy_id, "policy_status": "creating", "active": False})
        self._save(creating)
        status, reasons = self._wait_active(policy_id)
        log.info("policy %s -> %s in %.1fs", policy_id, status, self._mono() - started)
        if status == "ACTIVE":
            return self._save(creating.model_copy(update={"policy_status": "active", "active": True}))
        if status.endswith("FAILED"):
            self._save(creating.model_copy(update={"policy_status": "failed"}))
            raise PolicyError(f"policy {policy_id} {status}: {'; '.join(map(str, reasons))}")
        raise PolicyPropagatingError(creating)

    def finish(self, rule: Rule, timeout: float = 120.0) -> Rule:
        """Keep waiting for a policy that ``create`` left ``creating`` (AgentCore took 7-13 s to reach ACTIVE when
        measured), then record it active. Meant for a background thread; the wrapper honours ``creating`` rules
        locally in the meantime."""
        if not rule.policy_id:
            raise PolicyError("rule has no policy id", "INVALID_INPUT")
        saved_timeout, self.timeout = self.timeout, timeout
        try:
            status, reasons = self._wait_active(rule.policy_id)
        finally:
            self.timeout = saved_timeout
        if status == "ACTIVE":
            return self._save(rule.model_copy(update={"policy_status": "active", "active": True}))
        if status.endswith("FAILED"):
            self._save(rule.model_copy(update={"policy_status": "failed", "active": False}))
            raise PolicyError(f"policy {rule.policy_id} {status}: {'; '.join(map(str, reasons))}")
        raise PolicyPropagatingError(rule)

    def disable(self, rule: Rule) -> Rule:
        if rule.policy_id:
            try:
                self.client.delete_policy(policyEngineId=self.engine_id, policyId=rule.policy_id)
            except self.client.exceptions.ResourceNotFoundException:
                log.info("policy %s already gone", rule.policy_id)
        return self._save(rule.model_copy(update={"policy_status": "disabled", "active": False}))


def ensure_policy_engine(client: Any, name: str, *, poll_interval: float = 2.0, timeout: float = 120.0,
                         sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    """Create (or find) the policy engine by name and wait until ACTIVE. Returns the engine description."""
    existing = next((e for e in client.list_policy_engines().get("policyEngines", []) if e.get("name") == name), None)
    engine = existing or client.create_policy_engine(name=name, description="Butler household rules")
    engine_id = engine["policyEngineId"]
    waited = 0.0
    while True:
        got = client.get_policy_engine(policyEngineId=engine_id)
        if got["status"] == "ACTIVE":
            return got
        if got["status"].endswith("FAILED") or waited >= timeout:
            raise PolicyError(f"policy engine {engine_id} is {got['status']}")
        sleep(poll_interval)
        waited += poll_interval


def attach_engine_to_gateway(client: Any, gateway_id: str, engine_arn: str, mode: str = "ENFORCE") -> None:
    """Point the Gateway at the policy engine (update_gateway needs the gateway's existing settings echoed back)."""
    gw = client.get_gateway(gatewayIdentifier=gateway_id)
    keep = ("name", "description", "roleArn", "protocolType", "protocolConfiguration", "authorizerType",
            "authorizerConfiguration", "kmsKeyArn", "interceptorConfigurations", "exceptionLevel")
    kwargs = {k: gw[k] for k in keep if k in gw}
    client.update_gateway(gatewayIdentifier=gateway_id,
                          policyEngineConfiguration={"arn": engine_arn, "mode": mode}, **kwargs)


__all__ = [
    "AgentCorePolicyService",
    "LocalPolicyService",
    "PolicyError",
    "PolicyPropagatingError",
    "PolicyService",
    "attach_engine_to_gateway",
    "ensure_policy_engine",
    "policy_name",
    "replace",
]
