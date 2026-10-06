"""Preference learning (A-10): remember merchants and providers after executed purchases and bookings."""
from __future__ import annotations

from butler_contracts.models import Decision

from .context import RunContext


def learn_from_decision(ctx: RunContext, decision: Decision) -> None:
    """After a decision ran, note the chosen merchant/provider so the next plan prefers it."""
    if decision.status != "executed" or not decision.result_action_id:
        return
    receipt = ctx.store.get_receipt(ctx.household_id, decision.result_action_id)
    if receipt is None or receipt.status != "executed":
        return
    args = receipt.action.args
    if receipt.action.tool == "Supplies___checkout" and args.get("category") and args.get("merchant"):
        ctx.note_preference(f"merchant:{args['category']}", str(args["merchant"]), receipt.action_id)
    elif receipt.action.tool == "Services___book_service" and args.get("service_type"):
        chosen = next((o for o in decision.options if o.option_id == decision.chosen_option_id), None)
        if chosen is not None:
            ctx.note_preference(f"provider:{args['service_type']}", chosen.title, receipt.action_id)
