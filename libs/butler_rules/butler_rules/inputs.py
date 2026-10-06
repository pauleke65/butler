"""Projection of tool arguments into the Cedar ``context.input`` record, and fail-closed type checks.

Cedar skips a policy that errors (e.g. ``"6000" > 5000``), so a type-confused argument would let a
``forbid`` fail open. ``policy_field_problems`` is the guard that rejects such inputs before they reach the
Gateway; the Lambdas re-validate too (contracts §7).
"""
from __future__ import annotations

from typing import Any

INT64_MAX = 2**63 - 1
POLICY_STR_FIELDS = ("category", "recipient_email", "event_owner")


def _clean(v: Any) -> Any:
    """Drop what Cedar JSON cannot hold (None, floats, out-of-range ints) recursively."""
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items() if _keep(x)}
    if isinstance(v, list):
        return [_clean(x) for x in v if _keep(x)]
    return v


def _keep(v: Any) -> bool:
    if v is None or type(v) is float:
        return False
    return not (type(v) is int and abs(v) > INT64_MAX)


def cedar_input(args: dict[str, Any]) -> dict[str, Any]:
    """The ``context.input`` value for ``args`` (shared by the matcher and the Cedar evaluator)."""
    return _clean({k: v for k, v in args.items() if k != "reasoning"})


REQUIRED_POLICY_FIELDS: dict[str, tuple[str, ...]] = {
    "Supplies___checkout": ("amount_minor", "category"),
    "Services___book_service": ("amount_minor",),
    "Calendar___update_event": ("event_owner",),
    "Calendar___delete_event": ("event_owner",),
}


def policy_field_problems(args: dict[str, Any], tool: str | None = None) -> list[str]:
    """Missing or mistyped policy-relevant fields (empty list = fine). Callers fail closed on problems."""
    out: list[str] = [f"{f} is required" for f in REQUIRED_POLICY_FIELDS.get(tool or "", ()) if args.get(f) is None]
    if tool == "Messages___send_email" and args.get("recipient_email") is None and not args.get("recipient_contact_ids"):
        out.append("recipient_email or recipient_contact_ids is required")
    amt = args.get("amount_minor")
    if amt is not None and (type(amt) is not int or abs(amt) > INT64_MAX):
        out.append("amount_minor must be an integer")
    for f in POLICY_STR_FIELDS:
        v = args.get(f)
        if v is not None and not isinstance(v, str):
            out.append(f"{f} must be a string")
    ids = args.get("recipient_contact_ids")
    if ids is not None and (not isinstance(ids, list) or any(not isinstance(x, str) for x in ids)):
        out.append("recipient_contact_ids must be a list of strings")
    return out
