"""Environment-driven configuration (05-local-build §1). Code never branches on mode outside the factory."""
from __future__ import annotations

import os

DEFAULT_PLANNER_MODEL = "us.amazon.nova-2-lite-v1:0"
DEFAULT_FAST_MODEL = "us.amazon.nova-2-lite-v1:0"


def llm_mode() -> str:
    return os.environ.get("LLM_MODE", "offline").lower()


def planner_model() -> str:
    return os.environ.get("BEDROCK_MODEL_PLANNER", DEFAULT_PLANNER_MODEL)


def fast_model() -> str:
    return os.environ.get("BEDROCK_MODEL_FAST", DEFAULT_FAST_MODEL)


def aws_region() -> str:
    return os.environ.get("AWS_REGION", "us-east-1")


MAX_STEPS = 25
MAX_SECONDS = 120.0
RULE_CONFIDENCE_THRESHOLD = 0.6
