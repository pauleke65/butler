"""Module-level entry point used by the HTTP server and tests: ``handle(request)``."""
from __future__ import annotations

from typing import Any

from .agent import Agent
from .factory import build_agent

_default: Agent | None = None


def default_agent() -> Agent:
    global _default
    if _default is None:
        _default = build_agent()
    return _default


def handle(request: dict[str, Any], *, agent: Agent | None = None, run_async: bool = False) -> dict[str, Any]:
    """AgentRequest -> AgentResponse (contracts §5). With ``run_async`` start/resume return immediately."""
    return (agent or default_agent()).handle(request, run_async=run_async)
