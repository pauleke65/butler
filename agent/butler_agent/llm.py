"""Thin Bedrock Converse wrapper shared by the LLM planner and the LLM rule drafter."""
from __future__ import annotations

import logging
from typing import Any

import boto3
from botocore.config import Config

from .config import aws_region, fast_model

log = logging.getLogger("butler.llm")


class BedrockLLM:
    """``converse`` returns the raw Converse response; helpers pull text / tool calls out of it."""

    def __init__(self, client: Any | None = None, region: str | None = None):
        self.client = client or boto3.client(
            "bedrock-runtime", region_name=region or aws_region(),
            config=Config(read_timeout=60, retries={"max_attempts": 2, "mode": "standard"}))

    def converse(self, *, model_id: str, system: str, messages: list[dict[str, Any]],
                 tools: list[dict[str, Any]] | None = None, force_tool: str | None = None,
                 max_tokens: int = 2048) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "modelId": model_id, "system": [{"text": system}], "messages": messages,
            "inferenceConfig": {"maxTokens": max_tokens},
        }
        if tools:
            tool_config: dict[str, Any] = {"tools": [{"toolSpec": t} for t in tools]}
            if force_tool:
                tool_config["toolChoice"] = {"tool": {"name": force_tool}}
            kwargs["toolConfig"] = tool_config
            if is_nova(model_id):
                kwargs["inferenceConfig"]["temperature"] = 0
                kwargs.update(tool_decoding(model_id))
        return self.client.converse(**kwargs)

    def text(self, model_id: str, system: str, user: str, max_tokens: int = 64) -> str:
        res = self.converse(model_id=model_id, system=system, max_tokens=max_tokens,
                            messages=[{"role": "user", "content": [{"text": user}]}])
        return response_text(res)

    def ping(self) -> str:
        """One tiny call with the fast model (used by the opt-in bedrock test)."""
        return self.text(fast_model(), "Reply with one word.", "Say OK.", max_tokens=16)


def is_nova(model_id: str) -> bool:
    return "amazon.nova" in model_id


def tool_decoding(model_id: str) -> dict[str, Any]:
    """Greedy decoding for tool calls, as the Amazon Nova guide recommends (fewer malformed tool calls).
    Paired with ``temperature: 0`` in ``inferenceConfig``; returns the extra Converse kwargs."""
    if not is_nova(model_id):
        return {}
    return {"additionalModelRequestFields": {"inferenceConfig": {"topK": 1}}}


def response_blocks(res: dict[str, Any]) -> list[dict[str, Any]]:
    return res.get("output", {}).get("message", {}).get("content", [])


def response_text(res: dict[str, Any]) -> str:
    return "".join(b["text"] for b in response_blocks(res) if "text" in b).strip()


def response_tool_uses(res: dict[str, Any]) -> list[dict[str, Any]]:
    return [b["toolUse"] for b in response_blocks(res) if "toolUse" in b]
