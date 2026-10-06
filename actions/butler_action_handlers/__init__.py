"""Gateway action tools (contracts §7): validated, idempotent handlers over pluggable adapters."""
from .adapters import Adapters, default_adapters, fake_adapters
from .dispatch import TOOLS, dispatch

__all__ = ["TOOLS", "Adapters", "default_adapters", "dispatch", "fake_adapters"]
