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
        return AgentCorePolicyService(client, engine_id, store=store)
    return LocalPolicyService(store, ids=ids, activation_delay_ms=int(os.environ.get("LOCAL_POLICY_ACTIVATION_MS", "0")))


def build_gateway():
    from butler_actions.gateway import HttpGatewayClient

    return HttpGatewayClient.from_env()


def build_agent(mode: str | None = None) -> Agent:
    store = Store()
    ids = Identities.from_env()
    services = Services(store=store, gateway=build_gateway(), planner=build_planner(mode), drafter=build_drafter(mode),
                        policy=build_policy_service(store, ids), ids=ids, store_factory=Store)
    return Agent(services)
