"""Planners: the execution loop behind ``start_plan`` / ``resume_plan`` (contracts §5.1)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from ..context import RunContext


class Planner(Protocol):
    def run(self, ctx: RunContext) -> None:
        """Work every ``doing`` need to a terminal state. Must leave no need ``doing``."""
