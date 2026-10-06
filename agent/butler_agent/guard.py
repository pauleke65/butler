"""Hard limits for one agent run (contracts §5.1 rule 5): 25 gateway calls, 120 s wall clock.

The retry-after-deny guard (rule 2) lives in ``butler_actions.wrapper.RunGuard``; the context passes one in.
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .config import MAX_SECONDS, MAX_STEPS


class RunLimitExceeded(Exception):
    """25 gateway calls or 120 s reached: remaining needs are blocked with a retry note."""


@dataclass
class RunGuard:
    max_steps: int = MAX_STEPS
    max_seconds: float = MAX_SECONDS
    monotonic: Callable[[], float] = time.monotonic
    steps: int = 0
    started: float = field(init=False)

    def __post_init__(self) -> None:
        self.started = self.monotonic()

    def check_time(self) -> None:
        if self.monotonic() - self.started > self.max_seconds:
            raise RunLimitExceeded(f"{self.max_seconds:.0f}s wall clock reached")

    def before_call(self) -> None:
        """Count one gateway call; raises ``RunLimitExceeded`` at the step or time cap."""
        self.check_time()
        if self.steps >= self.max_steps:
            raise RunLimitExceeded(f"{self.max_steps} gateway calls reached")
        self.steps += 1
