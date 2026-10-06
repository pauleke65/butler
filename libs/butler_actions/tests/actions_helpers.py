from datetime import UTC, datetime, timedelta

from butler_actions.ids import new_id
from butler_contracts.models import Receipt

NOW = datetime(2026, 10, 6, 12, 0, tzinfo=UTC)


def add_purchase(store, *, days_ago: int, tool="Supplies___checkout", status="executed", hh="hh_t", **args):
    created = NOW - timedelta(days=days_ago)
    r = Receipt(
        action_id=new_id("act", int(created.timestamp() * 1000)), household_id=hh, correlation_id="c",
        action={"tool": tool, "args": args}, title="t", status=status, reasons=[], context_used=[], alternatives=[],
        authority={"decision": "ALLOW", "principal": "butler-agent", "rule_ids": [], "rule_texts": [],
                   "evaluated_at": created.isoformat(), "matcher_gateway_agree": True},
        reversible=False, might_disagree={"score": 0}, simulated=True, spoken_summary="Done.",
        created_at=created.isoformat())
    store.put_receipt(r)
    return r
