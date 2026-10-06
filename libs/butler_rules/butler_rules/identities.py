"""Gateway identities used in Cedar (contracts §9.1)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

PrincipalName = Literal["butler-agent", "approval-executor"]

LOCAL_GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-east-1:000000000000:gateway/local"


@dataclass(frozen=True)
class Identities:
    """Cognito client ids of the two principals plus the Gateway ARN."""

    agent_sub: str
    executor_sub: str
    gateway_arn: str

    @staticmethod
    def local() -> Identities:
        return Identities("local-agent", "local-executor", LOCAL_GATEWAY_ARN)

    @staticmethod
    def from_env() -> Identities:
        """AGENT_SUB / EXECUTOR_SUB / GATEWAY_ARN, falling back to the local identities."""
        loc = Identities.local()
        return Identities(
            os.environ.get("AGENT_SUB", loc.agent_sub),
            os.environ.get("EXECUTOR_SUB", loc.executor_sub),
            os.environ.get("GATEWAY_ARN", loc.gateway_arn),
        )

    def sub_for(self, principal: PrincipalName) -> str:
        return self.agent_sub if principal == "butler-agent" else self.executor_sub
