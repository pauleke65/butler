"""Run from the repo root: ``uv run pytest infra/runtime/tests``."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import agent_entry
from butler_actions.gateway import HttpGatewayClient
from butler_agent import factory


class FakeSecrets:
    def __init__(self):
        self.asked = []

    def get_secret_value(self, SecretId):
        self.asked.append(SecretId)
        return {"SecretString": "client-secret\n"}


def test_noop_without_cognito_url():
    assert agent_entry.install_cognito_gateway({}) is False


def test_installs_cognito_gateway_for_the_agent_only(monkeypatch):
    monkeypatch.setattr(factory, "build_gateway", factory.build_gateway)  # restore on teardown
    env = {"COGNITO_TOKEN_URL": "https://auth.example/oauth2/token", "AGENT_CLIENT_ID": "cid", "AGENT_CLIENT_SECRET_ARN": "arn:secret",
           "AGENT_SCOPE": "butler/invoke", "GATEWAY_URL": "https://gw.example/mcp"}
    secrets = FakeSecrets()
    assert agent_entry.install_cognito_gateway(env, secrets) is True
    assert secrets.asked == ["arn:secret"]
    gw = factory.build_gateway()
    assert isinstance(gw, HttpGatewayClient) and gw.url == "https://gw.example/mcp"
    assert set(gw.tokens) == {"butler-agent"}  # no approval-executor token provider
