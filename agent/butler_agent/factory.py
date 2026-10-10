"""The one place that chooses implementations from the environment (LLM_MODE, STAGE)."""
from __future__ import annotations

import os

from butler_actions.store import Store
from butler_rules import Identities, LocalPolicyService

from .agent import Agent, Services
from .config import llm_mode
from .drafter import PatternRuleDrafter, RuleDrafter
from .planner import Planner
from .planner.scripted import ScriptedPlanner


def build_planner(mode: str | None = None) -> Planner:
    if (mode or llm_mode()) == "bedrock":
        from .llm import BedrockLLM
        from .llm_planner import StrandsPlanner

        return StrandsPlanner(BedrockLLM())
    return ScriptedPlanner()


def build_drafter(mode: str | None = None) -> RuleDrafter:
    if (mode or llm_mode()) == "bedrock":
        from .llm import BedrockLLM
        from .llm_drafter import LLMRuleDrafter

        return LLMRuleDrafter(BedrockLLM(), fallback=PatternRuleDrafter())
    return PatternRuleDrafter()


def build_policy_service(store: Store, ids: Identities):
    engine_id = os.environ.get("POLICY_ENGINE_ID")
    if engine_id and os.environ.get("STAGE", "local") != "local":
        import boto3
        from butler_rules import AgentCorePolicyService

        client = boto3.client("bedrock-agentcore-control", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        # Same validation mode as the deploy (infra context policyValidationMode). AgentCore's validator flags our
        # agent-only forbids as "overly restrictive" for IAM principals, which this JWT-only gateway never sees.
        mode = os.environ.get("POLICY_VALIDATION_MODE", "FAIL_ON_ANY_FINDINGS")
        # Wait briefly for ACTIVE (AgentCore measured 7-13 s); after that the rule is finished in the background
        # while the wrapper honours it locally, so the customer is never left waiting on a voice turn.
        wait_s = float(os.environ.get("APPLY_RULE_WAIT_S", "4"))
        return AgentCorePolicyService(client, engine_id, store=store, validation_mode=mode, timeout=wait_s)
    return LocalPolicyService(store, ids=ids, activation_delay_ms=int(os.environ.get("LOCAL_POLICY_ACTIVATION_MS", "0")))


def build_gateway():
    """Local static tokens, or Cognito client credentials for ``butler-agent`` when COGNITO_TOKEN_URL is set (AWS)."""
    import os

    from butler_actions.gateway import CognitoClientCredentials, HttpGatewayClient

    token_url = os.environ.get("COGNITO_TOKEN_URL")
    if not token_url:
        return HttpGatewayClient.from_env()
    cred = CognitoClientCredentials(token_url, os.environ["AGENT_CLIENT_ID"], os.environ["AGENT_CLIENT_SECRET"],
                                    os.environ.get("AGENT_SCOPE"))
    return HttpGatewayClient(os.environ["GATEWAY_URL"], {"butler-agent": cred})


def build_agent(mode: str | None = None) -> Agent:
    store = Store()
    ids = Identities.from_env()
    services = Services(store=store, gateway=build_gateway(), planner=build_planner(mode), drafter=build_drafter(mode),
                        policy=build_policy_service(store, ids), ids=ids, store_factory=Store)
    return Agent(services)
