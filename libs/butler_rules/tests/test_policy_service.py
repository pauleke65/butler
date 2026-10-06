from datetime import UTC, datetime

import boto3
import pytest
from botocore.stub import Stubber
from butler_rules import (
    AgentCorePolicyService,
    LocalPolicyService,
    PolicyError,
    PolicyPropagatingError,
    attach_engine_to_gateway,
    default_rules,
    ensure_policy_engine,
    replace,
)
from butler_rules.policy_service import policy_name
from rules_cases import NOW, make_rule

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


def test_local_create_activates_and_persists(store, ids):
    slept = []
    svc = LocalPolicyService(store, ids=ids, activation_delay_ms=300, clock=lambda: T0, sleep=slept.append)
    draft = default_rules("hh_t", ids, NOW)[0]
    out = svc.create(draft)
    assert slept == [0.3]
    assert out.active and out.policy_status == "active" and out.policy_id == "local-rule_default_spend"
    assert out.updated_at.startswith("2026-10-06T12:00:00")
    assert store.get_rule("hh_t", "rule_default_spend").active
    assert [r.rule_id for r in store.list_rules("hh_t", active_only=True)] == ["rule_default_spend"]


def test_local_create_compiles_missing_cedar(store, ids):
    rule = make_rule("never_tool", {"tool": "Supplies___refund"}, ids, active=False).model_copy(
        update={"cedar_statement": ""})
    out = LocalPolicyService(store, ids=ids).create(rule)
    assert '@id("rule_t")' in out.cedar_statement


def test_local_disable_and_replace(store, ids):
    svc = LocalPolicyService(store, ids=ids, clock=lambda: T0)
    old = svc.create(make_rule("ask_category", {"category": "drinks"}, ids, rule_id="rule_old", active=False))
    new = make_rule("ask_category", {"category": "groceries"}, ids, rule_id="rule_new", active=False)
    created = replace(svc, old, new)
    assert created.active
    assert store.get_rule("hh_t", "rule_old").policy_status == "disabled" and not store.get_rule("hh_t", "rule_old").active
    assert [r.rule_id for r in store.list_rules("hh_t", active_only=True)] == ["rule_new"]


# ── AgentCore: botocore Stubber only (cannot run without AWS) ─────────────
def _client():
    return boto3.client("bedrock-agentcore-control", region_name="us-east-1",
                        aws_access_key_id="t", aws_secret_access_key="t")


def _policy_resp(status, reasons=()):
    return {"policyId": "rule_t-0123456789", "name": "rule_t", "policyEngineId": "butler_eng-abcdefghij",
            "createdAt": T0, "updatedAt": T0, "policyArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/butler_eng-abcdefghij/policy/rule_t-0123456789",
            "status": status, "statusReasons": list(reasons),
            "definition": {"cedar": {"statement": "permit (principal, action, resource);" + " " * 20}}}


def _svc(client, store=None, **kw):
    return AgentCorePolicyService(client, "butler_eng-abcdefghij", store=store, sleep=lambda s: None, **kw)


def test_agentcore_create_polls_until_active(ids, store):
    client = _client()
    rule = make_rule("ask_category", {"category": "drinks"}, ids, active=False)
    with Stubber(client) as st:
        st.add_response("create_policy", _policy_resp("CREATING"), {
            "name": "rule_t", "policyEngineId": "butler_eng-abcdefghij", "description": rule.text,
            "definition": {"cedar": {"statement": rule.cedar_statement}}, "validationMode": "FAIL_ON_ANY_FINDINGS"})
        st.add_response("get_policy", _policy_resp("CREATING"), {"policyEngineId": "butler_eng-abcdefghij", "policyId": "rule_t-0123456789"})
        st.add_response("get_policy", _policy_resp("ACTIVE"), {"policyEngineId": "butler_eng-abcdefghij", "policyId": "rule_t-0123456789"})
        out = _svc(client, store).create(rule)
        st.assert_no_pending_responses()
    assert out.policy_id == "rule_t-0123456789" and out.policy_status == "active" and out.active
    assert store.get_rule("hh_t", "rule_t").policy_status == "active"


def test_agentcore_create_failed_surfaces_reason(ids, store):
    client = _client()
    rule = make_rule("ask_category", {"category": "drinks"}, ids, active=False)
    with Stubber(client) as st:
        st.add_response("create_policy", _policy_resp("CREATING"))
        st.add_response("get_policy", _policy_resp("CREATE_FAILED", ["Unrecognized attribute foo"]))
        with pytest.raises(PolicyError, match="Unrecognized attribute foo"):
            _svc(client, store).create(rule)
    assert store.get_rule("hh_t", "rule_t").policy_status == "failed"


def test_agentcore_timeout_is_policy_propagating(ids, store):
    client = _client()
    rule = make_rule("ask_category", {"category": "drinks"}, ids, active=False)
    ticks = iter(range(0, 1000, 20))
    with Stubber(client) as st:
        st.add_response("create_policy", _policy_resp("CREATING"))
        for _ in range(5):
            st.add_response("get_policy", _policy_resp("CREATING"))
        svc = AgentCorePolicyService(client, "butler_eng-abcdefghij", store=store, timeout=60, sleep=lambda s: None,
                                     monotonic=lambda: next(ticks))
        with pytest.raises(PolicyPropagatingError) as ei:
            svc.create(rule)
    assert ei.value.code == "POLICY_PROPAGATING" and ei.value.rule.policy_status == "creating"
    assert not ei.value.rule.active


def test_agentcore_conflict_reuses_existing_policy(ids):
    client = _client()
    rule = make_rule("ask_category", {"category": "drinks"}, ids, active=False)
    with Stubber(client) as st:
        st.add_client_error("create_policy", "ConflictException", "exists", 409)
        st.add_response("list_policies", {"policies": [{**_policy_resp("ACTIVE"), "name": "rule_t"}]},
                        {"policyEngineId": "butler_eng-abcdefghij"})
        st.add_response("get_policy", _policy_resp("ACTIVE"))
        out = _svc(client).create(rule)
    assert out.policy_id == "rule_t-0123456789" and out.active


def test_agentcore_create_requires_statement(ids):
    rule = make_rule("ask_category", {"category": "drinks"}, ids).model_copy(update={"cedar_statement": ""})
    with pytest.raises(PolicyError):
        _svc(_client()).create(rule)


def test_agentcore_disable_deletes_policy_and_tolerates_missing(ids, store):
    client = _client()
    rule = make_rule("ask_category", {"category": "drinks"}, ids).model_copy(update={"policy_id": "rule_t-0123456789"})
    with Stubber(client) as st:
        st.add_response("delete_policy", _policy_resp("DELETING"), {"policyEngineId": "butler_eng-abcdefghij", "policyId": "rule_t-0123456789"})
        out = _svc(client, store).disable(rule)
        st.add_client_error("delete_policy", "ResourceNotFoundException", "gone", 404)
        out2 = _svc(client, store).disable(rule)
    assert out.policy_status == out2.policy_status == "disabled" and not out.active


def test_policy_name_is_valid_for_agentcore():
    assert policy_name("rule_01JABC") == "rule_01JABC"
    assert policy_name("1-bad id")[0].isalpha() and "-" not in policy_name("1-bad id")
    assert len(policy_name("rule_" + "x" * 80)) == 48


def test_ensure_policy_engine_creates_and_waits():
    client = _client()
    eng = {"policyEngineId": "butler_eng-abcdefghij", "name": "butler", "createdAt": T0, "updatedAt": T0,
           "policyEngineArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:policy-engine/butler_eng-abcdefghij",
           "status": "CREATING", "statusReasons": []}
    with Stubber(client) as st:
        st.add_response("list_policy_engines", {"policyEngines": []})
        st.add_response("create_policy_engine", eng)
        st.add_response("get_policy_engine", eng)
        st.add_response("get_policy_engine", {**eng, "status": "ACTIVE"})
        got = ensure_policy_engine(client, "butler", sleep=lambda s: None)
    assert got["status"] == "ACTIVE"


def test_attach_engine_to_gateway_echoes_settings():
    from unittest.mock import MagicMock

    client = MagicMock()
    client.get_gateway.return_value = {"name": "g", "roleArn": "r", "protocolType": "MCP", "authorizerType": "CUSTOM_JWT",
                                       "status": "READY", "gatewayArn": "x"}
    attach_engine_to_gateway(client, "gw-1", "arn:engine")
    kw = client.update_gateway.call_args.kwargs
    assert kw["policyEngineConfiguration"] == {"arn": "arn:engine", "mode": "ENFORCE"}
    assert kw["name"] == "g" and kw["roleArn"] == "r" and "status" not in kw
