"""AgentCore Runtime entrypoint for the Butler agent (direct code deployment, HTTP protocol on :8080).

``butler_agent.server`` already serves ``POST /invocations`` and ``GET /ping`` on 0.0.0.0:8080, but in AWS the agent
must call the Gateway with a Cognito client-credentials token for the ``butler-agent`` client, whereas
``butler_agent.factory.build_gateway`` only knows the static local tokens. Until that is built into the factory
(the executor already does it in ``butler_executor.handler.default_gateway``), this shim swaps in a Cognito-backed
gateway client before the server starts. It lives in infra/ on purpose: no application code was changed.

Environment (set by the CDK stack): COGNITO_TOKEN_URL, AGENT_CLIENT_ID, AGENT_CLIENT_SECRET_ARN, AGENT_SCOPE,
GATEWAY_URL. The secret is read from Secrets Manager once at startup; the agent role can read only that secret.
The agent gets a token provider for ``butler-agent`` ONLY, so it cannot act as ``approval-executor``.
"""
from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("butler.agent_entry")


def read_client_secret(secret_arn: str, client: Any | None = None) -> str:
    if client is None:
        import boto3

        client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    return client.get_secret_value(SecretId=secret_arn)["SecretString"].strip()


def install_cognito_gateway(env: dict[str, str] | None = None, secrets_client: Any | None = None) -> bool:
    """Replace ``factory.build_gateway`` with a Cognito-authenticated client. False when COGNITO_TOKEN_URL is unset."""
    env = dict(os.environ) if env is None else env
    token_url = env.get("COGNITO_TOKEN_URL")
    if not token_url:
        return False
    from butler_actions.gateway import CognitoClientCredentials, HttpGatewayClient
    from butler_agent import factory

    secret = read_client_secret(env["AGENT_CLIENT_SECRET_ARN"], secrets_client)
    credentials = CognitoClientCredentials(token_url, env["AGENT_CLIENT_ID"], secret, env.get("AGENT_SCOPE"))
    gateway_url = env["GATEWAY_URL"]
    factory.build_gateway = lambda: HttpGatewayClient(gateway_url, {"butler-agent": credentials})  # type: ignore[dict-item]
    log.info("agent gateway client uses Cognito client credentials (%s)", token_url)
    return True


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    install_cognito_gateway()
    from butler_agent.server import main as serve

    serve()


if __name__ == "__main__":
    main()
