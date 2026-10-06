"""The executor Lambda entry: secret resolution from Secrets Manager and delegation to the real handler."""
import boto3
from butler_actions.testing import CedarFakeGateway
from butler_executor import lambda_handler as lh
from moto import mock_aws


def test_load_client_secret_reads_secrets_manager(monkeypatch):
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        sm = boto3.client("secretsmanager", region_name="us-east-1")
        arn = sm.create_secret(Name="butler/dev/executor-client", SecretString="s3cr3t\n")["ARN"]
        env = {"EXECUTOR_CLIENT_SECRET_ARN": arn}
        lh.load_client_secret(env, client=sm)
        assert env["EXECUTOR_CLIENT_SECRET"] == "s3cr3t"


def test_load_client_secret_is_a_noop_when_set_or_unconfigured():
    class Boom:
        def get_secret_value(self, **_):
            raise AssertionError("must not be called")

    env = {"EXECUTOR_CLIENT_SECRET": "already", "EXECUTOR_CLIENT_SECRET_ARN": "arn:x"}
    lh.load_client_secret(env, client=Boom())
    assert env["EXECUTOR_CLIENT_SECRET"] == "already"
    lh.load_client_secret({}, client=Boom())


def test_handler_delegates_and_validates_mode(store):
    res = lh.handler({"mode": "bogus", "household_id": "hh_t", "correlation_id": "c"}, None, store=store, gateway=CedarFakeGateway(store))
    assert res["ok"] is False and res["error"]["code"] == "INVALID_INPUT"


def test_handler_builds_gateway_once_from_secret(store, monkeypatch):
    monkeypatch.setattr(lh, "_gateway", None)
    calls = []
    sentinel = CedarFakeGateway(store)
    monkeypatch.setattr(lh, "load_client_secret", lambda *a, **k: calls.append("secret"))
    monkeypatch.setattr(lh._handler_module, "default_gateway", lambda: (calls.append("gateway"), sentinel)[1])
    for _ in range(2):
        lh.handler({"mode": "bogus", "household_id": "hh_t", "correlation_id": "c"}, None, store=store)
    assert calls == ["secret", "gateway"]
