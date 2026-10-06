"""AWS Lambda entry point for the approval executor (contracts section 6).

``butler_executor.handler.handler`` is already Lambda-shaped but reads the Cognito client secret from the
``EXECUTOR_CLIENT_SECRET`` environment variable. In AWS the secret lives in Secrets Manager and the function's role may
read only that one secret, so this entry resolves ``EXECUTOR_CLIENT_SECRET_ARN`` once per container and then delegates.
The Gateway client (with its cached Cognito token) is reused across invocations of a warm container.
"""
from __future__ import annotations

import os
from typing import Any

from butler_actions.gateway import GatewayClient
from butler_actions.store import Store

from . import handler as _handler_module

_gateway: GatewayClient | None = None
_store: Store | None = None


def load_client_secret(env: dict[str, str] | None = None, client: Any | None = None) -> None:
    """Put the executor client secret into ``EXECUTOR_CLIENT_SECRET`` from Secrets Manager (no-op when already set)."""
    env = os.environ if env is None else env
    arn = env.get("EXECUTOR_CLIENT_SECRET_ARN")
    if env.get("EXECUTOR_CLIENT_SECRET") or not arn:
        return
    if client is None:
        import boto3

        client = boto3.client("secretsmanager", region_name=env.get("AWS_REGION", "us-east-1"))
    env["EXECUTOR_CLIENT_SECRET"] = client.get_secret_value(SecretId=arn)["SecretString"].strip()


def handler(event: dict[str, Any], context: Any = None, *, store: Store | None = None,
            gateway: GatewayClient | None = None) -> dict[str, Any]:
    global _gateway, _store
    if gateway is None:
        if _gateway is None:
            load_client_secret()
            _gateway = _handler_module.default_gateway()
        gateway = _gateway
    if store is None:
        if _store is None:
            _store = Store()
        store = _store
    return _handler_module.handler(event, context, store=store, gateway=gateway)
