"""Writes the shared fixtures through the Python Store (libs/butler_actions/store.py) into an in-process moto
DynamoDB and dumps the raw items. server/test/storeLayout.test.ts compares the TypeScript repo's items to this file.

Regenerate with:  uv run python server/test/golden/gen_store_golden.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.pop("DYNAMODB_ENDPOINT", None)

import time  # noqa: E402

from moto import mock_aws  # noqa: E402

from butler_actions.store import Store  # noqa: E402
from butler_contracts.models import Contact, Decision, Household, Plan, Receipt, Rule  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
FIX = ROOT / "packages/contracts/fixtures"
SEED = ROOT / "seed"
OUT = Path(__file__).with_name("store_items.golden.json")
HH = "hh_demo"


def load(p: Path):
    return json.loads(p.read_text())


with mock_aws():
    store = Store.create_table("butler-golden")
    store.put_household(Household(**load(SEED / "household.json")["household"]))
    for c in load(SEED / "contacts.json"):
        store.put_contact(HH, Contact(**c))
    for name in ("plan-hosting.json", "plan-away.json"):
        store.put_plan(Plan(**load(FIX / name)))
    for d in load(FIX / "decisions.json"):
        store.put_decision(HH, Decision(**d))
    for r in load(FIX / "receipts.json"):
        store.put_receipt(Receipt(**r))
    for r in load(FIX / "rules.json"):
        store.put_rule(Rule(**r))
    store.set_latest_draft(HH, load(FIX / "rules.json")[-1]["rule_id"])

    items = []
    res = store.table.scan()
    items.extend(res["Items"])
    while "LastEvaluatedKey" in res:
        res = store.table.scan(ExclusiveStartKey=res["LastEvaluatedKey"])
        items.extend(res["Items"])

out = []
for it in items:
    it = dict(it)
    it["data"] = json.loads(it["data"])
    if it["SK"] == "DRAFT#LATEST":
        it["data"]["expires_at"] = "<epoch seconds>"
    out.append(it)
out.sort(key=lambda i: (i["PK"], i["SK"]))
OUT.write_text(json.dumps(out, indent=1, sort_keys=True, default=str) + "\n")
print(f"wrote {len(out)} items to {OUT}")
