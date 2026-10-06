"""DynamoDB single-table access (contracts §10).

Every item stores its payload as a JSON string in ``data`` next to the key attributes, so the
TypeScript server and the Python agent read and write the same shape without Decimal handling.
"""
from __future__ import annotations

import json
import os
import time
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from butler_contracts.models import (
    Contact,
    Decision,
    Household,
    Need,
    Plan,
    Preference,
    Receipt,
    Rule,
)

ALREADY_EXISTS = "ConditionalCheckFailedException"


def _dump(model: Any) -> str:
    if hasattr(model, "model_dump_json"):
        return model.model_dump_json(exclude_none=True)
    return json.dumps(model, default=str)


def _client_kwargs(region: str, endpoint_url: str | None) -> dict[str, Any]:
    """boto3 kwargs; a localhost endpoint (moto) gets explicit dummy credentials so real AWS creds stay untouched."""
    kwargs: dict[str, Any] = {"region_name": region}
    if endpoint_url:
        kwargs["endpoint_url"] = endpoint_url
        if urlparse(endpoint_url).hostname in ("localhost", "127.0.0.1", "::1"):
            kwargs.update(aws_access_key_id="test", aws_secret_access_key="test")
    return kwargs


class Store:
    def __init__(self, table_name: str | None = None, region: str | None = None, endpoint_url: str | None = None):
        self.table_name = table_name or os.environ.get("TABLE_NAME", "butler-local")
        region = region or os.environ.get("AWS_REGION", "us-east-1")
        endpoint_url = endpoint_url or os.environ.get("DYNAMODB_ENDPOINT") or None
        self._ddb = boto3.resource("dynamodb", **_client_kwargs(region, endpoint_url))
        self.table = self._ddb.Table(self.table_name)

    # ── table management ──────────────────────────────────────────────
    @classmethod
    def create_table(cls, table_name: str, region: str = "us-east-1", endpoint_url: str | None = None) -> Store:
        ddb = boto3.resource("dynamodb", **_client_kwargs(region, endpoint_url))
        existing = {t.name for t in ddb.tables.all()}
        if table_name not in existing:
            ddb.create_table(
                TableName=table_name,
                BillingMode="PAY_PER_REQUEST",
                AttributeDefinitions=[
                    {"AttributeName": "PK", "AttributeType": "S"},
                    {"AttributeName": "SK", "AttributeType": "S"},
                    {"AttributeName": "GSI1PK", "AttributeType": "S"},
                    {"AttributeName": "GSI1SK", "AttributeType": "S"},
                ],
                KeySchema=[{"AttributeName": "PK", "KeyType": "HASH"}, {"AttributeName": "SK", "KeyType": "RANGE"}],
                GlobalSecondaryIndexes=[
                    {
                        "IndexName": "GSI1",
                        "KeySchema": [
                            {"AttributeName": "GSI1PK", "KeyType": "HASH"},
                            {"AttributeName": "GSI1SK", "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    }
                ],
            )
        return cls(table_name, region, endpoint_url)

    # ── low level ─────────────────────────────────────────────────────
    def _put(self, pk: str, sk: str, model: Any, *, gsi: tuple[str, str] | None = None, type_: str,
             ttl: int | None = None, condition: str | None = None, extra: dict[str, Any] | None = None) -> None:
        item: dict[str, Any] = {"PK": pk, "SK": sk, "type": type_, "data": _dump(model)}
        if gsi:
            item["GSI1PK"], item["GSI1SK"] = gsi
        if ttl:
            item["ttl"] = ttl
        if extra:
            item.update(extra)
        kwargs: dict[str, Any] = {"Item": item}
        if condition:
            kwargs["ConditionExpression"] = condition
        self.table.put_item(**kwargs)

    def _get(self, pk: str, sk: str) -> dict[str, Any] | None:
        res = self.table.get_item(Key={"PK": pk, "SK": sk}, ConsistentRead=True)
        item = res.get("Item")
        return json.loads(item["data"]) if item else None

    def _query(self, pk: str, sk_prefix: str | None = None, *, forward: bool = True, limit: int | None = None,
               index: str | None = None) -> list[dict[str, Any]]:
        pk_name, sk_name = ("GSI1PK", "GSI1SK") if index else ("PK", "SK")
        cond = Key(pk_name).eq(pk)
        if sk_prefix is not None:
            cond = cond & Key(sk_name).begins_with(sk_prefix)
        kwargs: dict[str, Any] = {"KeyConditionExpression": cond, "ScanIndexForward": forward}
        if index:
            kwargs["IndexName"] = index
        if limit:
            kwargs["Limit"] = limit
        out: list[dict[str, Any]] = []
        while True:
            res = self.table.query(**kwargs)
            out.extend(json.loads(i["data"]) for i in res["Items"])
            if limit and len(out) >= limit:
                return out[:limit]
            lek = res.get("LastEvaluatedKey")
            if not lek:
                return out
            kwargs["ExclusiveStartKey"] = lek

    # ── household / contacts / members ────────────────────────────────
    def put_household(self, hh: Household) -> None:
        self._put(f"HH#{hh.household_id}", "META", hh, type_="household")

    def get_household(self, household_id: str) -> Household | None:
        d = self._get(f"HH#{household_id}", "META")
        return Household(**d) if d else None

    def put_contact(self, household_id: str, c: Contact) -> None:
        self._put(f"HH#{household_id}", f"CONTACT#{c.contact_id}", c, type_="contact")

    def list_contacts(self, household_id: str) -> list[Contact]:
        return [Contact(**d) for d in self._query(f"HH#{household_id}", "CONTACT#")]

    def get_contact(self, household_id: str, contact_id: str) -> Contact | None:
        d = self._get(f"HH#{household_id}", f"CONTACT#{contact_id}")
        return Contact(**d) if d else None

    def put_member(self, household_id: str, member: dict[str, Any]) -> None:
        self._put(f"HH#{household_id}", f"MEMBER#{member['member_id']}", member, type_="member")

    def list_members(self, household_id: str) -> list[dict[str, Any]]:
        return self._query(f"HH#{household_id}", "MEMBER#")

    # ── plans and needs ───────────────────────────────────────────────
    def put_plan(self, plan: Plan) -> None:
        """Stores the plan header; needs live in separate items."""
        header = plan.model_copy(update={"needs": []})
        self._put(
            f"HH#{plan.household_id}", f"PLAN#{plan.plan_id}", header,
            gsi=(f"HH#{plan.household_id}#PLANS", plan.updated_at), type_="plan",
        )
        for n in plan.needs:
            self.put_need(n)

    def put_need(self, need: Need) -> None:
        self._put(f"PLAN#{need.plan_id}", f"NEED#{need.need_id}", need, type_="need")

    def get_need(self, plan_id: str, need_id: str) -> Need | None:
        d = self._get(f"PLAN#{plan_id}", f"NEED#{need_id}")
        return Need(**d) if d else None

    def list_needs(self, plan_id: str) -> list[Need]:
        return sorted((Need(**d) for d in self._query(f"PLAN#{plan_id}", "NEED#")), key=lambda n: n.need_id)

    def get_plan(self, household_id: str, plan_id: str) -> Plan | None:
        d = self._get(f"HH#{household_id}", f"PLAN#{plan_id}")
        if not d:
            return None
        plan = Plan(**d)
        plan.needs = self.list_needs(plan_id)
        return plan

    def list_plans(self, household_id: str, limit: int = 20) -> list[Plan]:
        rows = self._query(f"HH#{household_id}#PLANS", forward=False, limit=limit, index="GSI1")
        plans = []
        for d in rows:
            p = Plan(**d)
            p.needs = self.list_needs(p.plan_id)
            plans.append(p)
        return plans

    # ── decisions ─────────────────────────────────────────────────────
    def put_decision(self, household_id: str, dec: Decision) -> None:
        self._put(
            f"PLAN#{dec.plan_id}", f"DEC#{dec.decision_id}", dec,
            gsi=(f"HH#{household_id}#DEC#{dec.status}", dec.created_at), type_="decision",
            extra={"household_id": household_id},
        )

    def get_decision(self, plan_id: str, decision_id: str) -> Decision | None:
        d = self._get(f"PLAN#{plan_id}", f"DEC#{decision_id}")
        return Decision(**d) if d else None

    def find_decision(self, household_id: str, decision_id: str) -> Decision | None:
        """Look a decision up without knowing its plan (scan of the household's plans)."""
        for plan in self.list_plans(household_id, limit=50):
            d = self.get_decision(plan.plan_id, decision_id)
            if d:
                return d
        return None

    def list_decisions(self, plan_id: str) -> list[Decision]:
        return [Decision(**d) for d in self._query(f"PLAN#{plan_id}", "DEC#")]

    def list_pending_decisions(self, household_id: str) -> list[Decision]:
        rows = self._query(f"HH#{household_id}#DEC#pending", index="GSI1")
        return [Decision(**d) for d in rows]

    def transition_decision(self, household_id: str, plan_id: str, decision_id: str,
                            from_status: str, to_status: str, **updates: Any) -> Decision | None:
        """Atomically move a decision between statuses. Returns the new decision, or None if the
        current status wasn't ``from_status`` (someone else got there first)."""
        key = {"PK": f"PLAN#{plan_id}", "SK": f"DEC#{decision_id}"}
        current = self.table.get_item(Key=key, ConsistentRead=True).get("Item")
        if not current:
            return None
        dec = Decision(**json.loads(current["data"]))
        if dec.status != from_status:
            return None
        new = dec.model_copy(update={"status": to_status, **updates})
        try:
            self.table.put_item(
                Item={**current, "data": _dump(new), "GSI1PK": f"HH#{household_id}#DEC#{to_status}"},
                ConditionExpression="#d = :old",
                ExpressionAttributeNames={"#d": "data"},
                ExpressionAttributeValues={":old": current["data"]},
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == ALREADY_EXISTS:
                return None
            raise
        return new

    # ── receipts ──────────────────────────────────────────────────────
    def put_receipt(self, r: Receipt) -> None:
        self._put(
            f"HH#{r.household_id}", f"ACT#{r.action_id}", r,
            gsi=(f"PLAN#{r.plan_id}#ACT" if r.plan_id else f"HH#{r.household_id}#NOPLAN#ACT", r.action_id),
            type_="receipt",
        )

    def get_receipt(self, household_id: str, action_id: str) -> Receipt | None:
        d = self._get(f"HH#{household_id}", f"ACT#{action_id}")
        return Receipt(**d) if d else None

    def list_receipts(self, household_id: str, *, newest_first: bool = True, limit: int | None = None) -> list[Receipt]:
        rows = self._query(f"HH#{household_id}", "ACT#", forward=not newest_first, limit=limit)
        return [Receipt(**d) for d in rows]

    def list_receipts_since(self, household_id: str, since: str | None, limit: int = 50) -> list[Receipt]:
        """Receipts with action_id > ``since`` (oldest first); with no ``since``, the newest ``limit`` oldest-first."""
        if not since:
            return list(reversed(self.list_receipts(household_id, newest_first=True, limit=limit)))
        res = self.table.query(
            KeyConditionExpression=Key("PK").eq(f"HH#{household_id}") & Key("SK").between(f"ACT#{since}", "ACT#~"),
            Limit=limit + 1,
        )
        out = [Receipt(**json.loads(i["data"])) for i in res["Items"]]
        return [r for r in out if r.action_id > since][:limit]

    def list_receipts_for_plan(self, plan_id: str) -> list[Receipt]:
        return [Receipt(**d) for d in self._query(f"PLAN#{plan_id}#ACT", index="GSI1")]

    # ── rules ─────────────────────────────────────────────────────────
    def put_rule(self, rule: Rule) -> None:
        self._put(
            f"HH#{rule.household_id}", f"RULE#{rule.rule_id}", rule,
            gsi=(f"HH#{rule.household_id}#RULES#{str(rule.active).lower()}", rule.created_at), type_="rule",
        )

    def get_rule(self, household_id: str, rule_id: str) -> Rule | None:
        d = self._get(f"HH#{household_id}", f"RULE#{rule_id}")
        return Rule(**d) if d else None

    def list_rules(self, household_id: str, *, active_only: bool = False) -> list[Rule]:
        if active_only:
            rows = self._query(f"HH#{household_id}#RULES#true", index="GSI1")
        else:
            rows = self._query(f"HH#{household_id}", "RULE#")
        return [Rule(**d) for d in rows]

    def delete_rule(self, household_id: str, rule_id: str) -> None:
        self.table.delete_item(Key={"PK": f"HH#{household_id}", "SK": f"RULE#{rule_id}"})

    def set_latest_draft(self, household_id: str, rule_id: str, ttl_seconds: int = 600) -> None:
        self._put(f"HH#{household_id}", "DRAFT#LATEST", {"rule_id": rule_id, "expires_at": int(time.time()) + ttl_seconds},
                  type_="draft_lock")

    def get_latest_draft(self, household_id: str) -> str | None:
        d = self._get(f"HH#{household_id}", "DRAFT#LATEST")
        if d and d["expires_at"] > time.time():
            return d["rule_id"]
        return None

    # ── preferences ───────────────────────────────────────────────────
    def put_preference(self, household_id: str, p: Preference) -> None:
        self._put(f"HH#{household_id}", f"PREF#{p.key}", p, type_="preference")

    def list_preferences(self, household_id: str) -> list[Preference]:
        return [Preference(**d) for d in self._query(f"HH#{household_id}", "PREF#")]

    # ── provider records (orders, bookings, events) for undo ──────────
    def put_record(self, household_id: str, kind: str, record_id: str, data: dict[str, Any]) -> None:
        self._put(f"HH#{household_id}", f"{kind.upper()}#{record_id}", data, type_=kind)

    def get_record(self, household_id: str, kind: str, record_id: str) -> dict[str, Any] | None:
        return self._get(f"HH#{household_id}", f"{kind.upper()}#{record_id}")

    def list_records(self, household_id: str, kind: str) -> list[dict[str, Any]]:
        return self._query(f"HH#{household_id}", f"{kind.upper()}#")

    # ── idempotency ───────────────────────────────────────────────────
    def get_idempotent(self, key: str) -> dict[str, Any] | None:
        return self._get(f"IDEMP#{key}", "META")

    def put_idempotent(self, key: str, result: dict[str, Any], ttl_days: int = 7) -> bool:
        """Returns False if the key already existed (caller should read the original result)."""
        try:
            self._put(f"IDEMP#{key}", "META", result, type_="idempotency",
                      ttl=int(time.time()) + ttl_days * 86400, condition="attribute_not_exists(PK)")
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == ALREADY_EXISTS:
                return False
            raise

    def delete_idempotency_records(self) -> int:
        """Remove every IDEMP# item (demo reset)."""
        from boto3.dynamodb.conditions import Attr

        n = 0
        kwargs: dict[str, Any] = {"FilterExpression": Attr("PK").begins_with("IDEMP#")}
        while True:
            res = self.table.scan(**kwargs)
            for it in res["Items"]:
                self.table.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})
                n += 1
            if "LastEvaluatedKey" not in res:
                return n
            kwargs["ExclusiveStartKey"] = res["LastEvaluatedKey"]

    # ── maintenance (demo reset) ──────────────────────────────────────
    def delete_household_items(self, household_id: str, *, keep_prefixes: Iterable[str] = ("META", "CONTACT#", "MEMBER#")) -> int:
        keep = tuple(keep_prefixes)
        n = 0
        res = self.table.query(KeyConditionExpression=Key("PK").eq(f"HH#{household_id}"))
        plan_ids: list[str] = []
        for it in res["Items"]:
            sk = it["SK"]
            if sk.startswith("PLAN#"):
                plan_ids.append(sk.split("#", 1)[1])
            if not sk.startswith(keep):
                self.table.delete_item(Key={"PK": it["PK"], "SK": sk})
                n += 1
        for pid in plan_ids:
            for it in self.table.query(KeyConditionExpression=Key("PK").eq(f"PLAN#{pid}"))["Items"]:
                self.table.delete_item(Key={"PK": it["PK"], "SK": it["SK"]})
                n += 1
        return n
