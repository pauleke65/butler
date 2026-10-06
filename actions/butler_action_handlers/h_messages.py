"""Messages___send_email: resolve contact ids, enforce the sandbox allow-list, one email per recipient."""
from __future__ import annotations

import html
import os

from butler_contracts.models import SendEmailInput

from .context import Ctx
from .errors import InvalidInput, UpstreamUnavailable


def _allowlist(ctx: Ctx) -> set[str]:
    env = {e.strip().lower() for e in os.environ.get("SES_ALLOWED_RECIPIENTS", "").split(",") if e.strip()}
    return env | {c.email.lower() for c in ctx.store.list_contacts(ctx.household_id)}


def _resolve_contacts(ctx: Ctx, ids: list[str]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    unknown: list[str] = []
    for cid in dict.fromkeys(ids):
        c = ctx.store.get_contact(ctx.household_id, cid)
        if c is None:
            unknown.append(cid)
        else:
            out.append((c.email, c.first_name))
    if unknown:
        raise InvalidInput(f"Unknown contact ids: {', '.join(unknown)}")
    return out


def _resolve_address(ctx: Ctx, email: str) -> list[tuple[str, str]]:
    sandbox = os.environ.get("SES_SANDBOX", "true").lower() != "false"
    if sandbox and email.lower() not in _allowlist(ctx):
        raise UpstreamUnavailable("That address isn't verified for sending in this environment.")
    return [(email, email)]


def _html(body: str) -> str:
    paras = [p for p in body.split("\n\n") if p.strip()]
    return "".join(f"<p>{html.escape(p).replace(chr(10), '<br>')}</p>" for p in paras)


def send_email(ctx: Ctx, inp: SendEmailInput) -> dict:
    ids, address = inp.recipient_contact_ids or [], inp.recipient_email
    if bool(ids) == bool(address):
        raise InvalidInput("Provide exactly one of recipient_contact_ids or recipient_email.")
    recipients = _resolve_contacts(ctx, ids) if ids else _resolve_address(ctx, address or "")
    message_ids = [ctx.adapters.email.send(email, inp.subject, inp.body_text, _html(inp.body_text))
                   for email, _ in recipients]
    return {"message_ids": message_ids, "sent_to": [label for _, label in recipients]}
