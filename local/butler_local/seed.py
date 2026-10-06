"""Seed loader (``python -m butler_local.seed [--reset]``): household, contacts, default rules, history."""
from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from butler_actions import clock
from butler_actions.ids import deterministic_id
from butler_actions.store import Store
from butler_actions.summaries import receipt_title, spoken_summary
from butler_contracts.models import Contact, Household, Receipt
from butler_rules import Identities, LocalPolicyService, default_rules

log = logging.getLogger("butler.seed")

DEFAULT_RULE_PREFIX = "RULE#rule_default_"


def seed_dir() -> Path:
    """``SEED_DIR`` or the repo's ``seed/`` folder."""
    env = os.environ.get("SEED_DIR")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "seed"


def _json(name: str, base: Path) -> Any:
    return json.loads((base / name).read_text())


def load_household(store: Store, base: Path) -> str:
    data = _json("household.json", base)
    hh = Household(**data["household"])
    store.put_household(hh)
    for member in data.get("members", []):
        store.put_member(hh.household_id, member)
    for c in _json("contacts.json", base):
        store.put_contact(hh.household_id, Contact(**c))
    return hh.household_id


def load_default_rules(store: Store, household_id: str, ids: Identities, now: datetime) -> int:
    """Compile and activate the five §9.4 defaults (stamped a day old, so the local Gateway enforces them at once)."""
    svc = LocalPolicyService(store, ids=ids, clock=lambda: now - timedelta(days=1))
    rules = default_rules(household_id, ids, clock.iso(now))
    for rule in rules:
        svc.create(rule)
    return len(rules)


def history_receipt(household_id: str, entry: dict[str, Any], index: int, now: datetime) -> Receipt:
    created = now - timedelta(days=entry["days_ago"])
    args = {"merchant": entry["merchant"], "items": entry["items"], "amount_minor": entry["amount_minor"],
            "currency": "USD", "category": entry["category"]}
    result = {"order_id": f"ord_seed{index:02d}", "payment_ref": f"pay_seed{index:02d}", "amount_minor": entry["amount_minor"],
              "eta": "next day", "simulated_merchant": True, "payment_mode": "test"}
    reasons = [f"Restocked {entry['category']}"]
    tool = entry["tool"]
    return Receipt(
        action_id=deterministic_id("act", int(created.timestamp() * 1000), f"seed-history-{index}"),
        household_id=household_id, correlation_id=f"cor_seed{index:02d}", action={"tool": tool, "args": args},
        title=entry.get("title") or receipt_title(tool, "executed", args), status="executed", reasons=reasons,
        context_used=[], alternatives=[],
        authority={"decision": "ALLOW", "principal": "butler-agent", "rule_ids": [], "rule_texts": [],
                   "evaluated_at": clock.iso(created), "matcher_gateway_agree": True},
        cost={"amount_minor": entry["amount_minor"], "currency": "USD"}, result=result, reversible=True,
        might_disagree={"score": 0.0}, simulated=True,
        spoken_summary=spoken_summary(tool, "executed", args, result, reasons, [], now=created),
        created_at=clock.iso(created),
    )


def load_history(store: Store, household_id: str, base: Path, now: datetime) -> int:
    entries = _json("history.json", base)["receipts"]
    for i, entry in enumerate(entries):
        store.put_receipt(history_receipt(household_id, entry, i, now))
    return len(entries)


def reset(store: Store, household_id: str) -> int:
    """Clear plans, decisions, receipts, orders, bookings, events and non-default rules (keeps household, contacts, defaults)."""
    n = store.delete_household_items(household_id, keep_prefixes=("META", "CONTACT#", "MEMBER#", DEFAULT_RULE_PREFIX))
    return n + store.delete_idempotency_records()


def seed(store: Store, *, do_reset: bool = False, base: Path | None = None, ids: Identities | None = None,
         now: datetime | None = None) -> dict[str, Any]:
    """Load everything; with ``do_reset`` first clear the demo state. Idempotent."""
    base, ids, now = base or seed_dir(), ids or Identities.from_env(), now or clock.now()
    hh = Household(**_json("household.json", base)["household"]).household_id
    removed = reset(store, hh) if do_reset else 0
    load_household(store, base)
    return {"household_id": hh, "removed": removed, "rules": load_default_rules(store, hh, ids, now),
            "receipts": load_history(store, hh, base, now)}


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description="Load Butler seed data into the local table.")
    parser.add_argument("--reset", action="store_true", help="clear demo state first (keeps household, contacts, defaults)")
    args = parser.parse_args(argv)
    endpoint = os.environ.get("DYNAMODB_ENDPOINT", "http://localhost:5555")
    store = Store.create_table(os.environ.get("TABLE_NAME", "butler-local"), os.environ.get("AWS_REGION", "us-east-1"), endpoint)
    summary = seed(store, do_reset=args.reset)
    log.info("seeded %s: %d default rules, %d history receipts (removed %d items)", summary["household_id"],
             summary["rules"], summary["receipts"], summary["removed"])


if __name__ == "__main__":
    main()
