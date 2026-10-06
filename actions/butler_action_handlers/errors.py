"""Error types shared by the action handlers (codes from contracts §14)."""
from __future__ import annotations


class ActionError(Exception):
    """A handler failure that maps to ``{"ok": False, "error": {"code", "message"}}``."""

    code = "INTERNAL"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code


class InvalidInput(ActionError):
    code = "INVALID_INPUT"


class NotFound(ActionError):
    code = "NOT_FOUND"


class UpstreamUnavailable(ActionError):
    code = "UPSTREAM_UNAVAILABLE"
