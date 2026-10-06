"""Per-call context handed to every handler."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from butler_actions.store import Store

from .adapters import Adapters
from .timeutil import DEFAULT_TZ


@dataclass
class Ctx:
    store: Store
    now: datetime
    adapters: Adapters
    household_id: str
    tz: str = DEFAULT_TZ

    def household(self) -> Any:
        return self.store.get_household(self.household_id)
