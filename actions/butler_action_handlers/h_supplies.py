"""Supplies___*: simulated catalogue, server-side re-validation of checkout, test-mode payments."""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from butler_actions.ids import new_id
from butler_contracts.models import CheckoutInput, RefundInput, SearchProductsInput

from . import seeddata
from .context import Ctx
from .errors import InvalidInput, NotFound
from .timeutil import delivery_eta, parse_instant

_STOP = {"for", "a", "the", "and", "of", "to", "some", "with", "in", "my", "me", "i", "need", "buy", "get"}
MAX_RESULTS = 5


def _norm(token: str) -> str:
    return token[:-1] if len(token) > 3 and token.endswith("s") else token


def _tokens(text: str) -> list[str]:
    return [_norm(t) for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in _STOP]


def _serves(name: str) -> int | None:
    """How many people a bundle serves, from its name ("... for 7", "3 people")."""
    m = re.search(r"\bfor (\d+)\b|\b(\d+) people\b", name.lower())
    return int(m[1] or m[2]) if m else None


def _score(product: dict[str, Any], query: str, query_tokens: list[str]) -> int:
    hay = set(_tokens(" ".join([product["name"], product["merchant"], product["category"], *product.get("keywords", [])])))
    score = sum(1 for t in query_tokens if t in hay)
    wanted = re.search(r"\b(\d+)\b", query)
    serves = _serves(product["name"])
    if wanted and serves is not None and serves >= int(wanted[1]):
        score += 1  # a bundle big enough for the party outranks one that is not
    return score


def _shape(product: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    eta, label = delivery_eta(product["delivery"], ctx.now, ctx.tz)
    return {"sku": product["sku"], "name": product["name"], "merchant": product["merchant"],
            "category": product["category"], "unit_price_minor": product["unit_price_minor"], "currency": "USD",
            "delivery_eta": eta.isoformat(timespec="minutes"), "delivery_label": label, "simulated": True}


def search_products(ctx: Ctx, inp: SearchProductsInput) -> dict:
    q = _tokens(inp.query)
    scored = [(_score(p, inp.query, q), p) for p in seeddata.catalog() if not inp.category or p["category"] == inp.category]
    if not inp.category:
        scored = [(s, p) for s, p in scored if s > 0]
    scored.sort(key=lambda sp: (-sp[0], sp[1]["unit_price_minor"], sp[1]["sku"]))
    products = [_shape(p, ctx) for _, p in scored]
    if inp.deliver_by:
        limit = parse_instant(inp.deliver_by, ctx.tz, end_of_day=True)
        products = [p for p in products if parse_instant(p["delivery_eta"], ctx.tz) <= limit]
    return {"products": products[: min(inp.max_results or MAX_RESULTS, MAX_RESULTS)]}


def _price_items(inp: CheckoutInput) -> tuple[int, list[dict[str, Any]]]:
    by_sku = seeddata.catalog_by_sku()
    unknown = [i.sku for i in inp.items if i.sku not in by_sku]
    if unknown:
        raise InvalidInput(f"Unknown SKUs: {', '.join(unknown)}")
    products = [by_sku[i.sku] for i in inp.items]
    wrong_category = [p["sku"] for p in products if p["category"] != inp.category]
    if wrong_category:
        raise InvalidInput(f"category {inp.category!r} does not match the catalogue category of: {', '.join(wrong_category)}")
    wrong_merchant = [p["sku"] for p in products if p["merchant"] != inp.merchant]
    if wrong_merchant:
        raise InvalidInput(f"merchant {inp.merchant!r} does not sell: {', '.join(wrong_merchant)}")
    total = sum(p["unit_price_minor"] * i.qty for p, i in zip(products, inp.items))
    if total != inp.amount_minor:
        raise InvalidInput(f"amount_minor {inp.amount_minor} does not match the catalogue total {total}.")
    return total, products


def checkout(ctx: Ctx, inp: CheckoutInput) -> dict:
    total, products = _price_items(inp)
    etas: list[datetime] = [delivery_eta(p["delivery"], ctx.now, ctx.tz)[0] for p in products]
    eta = max(etas)
    if inp.deliver_by and eta > parse_instant(inp.deliver_by, ctx.tz, end_of_day=True):
        raise InvalidInput(f"These items arrive {eta.isoformat(timespec='minutes')}, after deliver_by {inp.deliver_by}.")
    payment_ref = ctx.adapters.payments.charge(
        total, inp.currency, f"Butler order from {inp.merchant}", inp.idempotency_key,
        {"household_id": ctx.household_id, "correlation_id": inp.correlation_id})
    order_id = new_id("ord")
    ctx.store.put_record(ctx.household_id, "order", order_id, {
        "order_id": order_id, "merchant": inp.merchant, "category": inp.category,
        "items": [i.model_dump() for i in inp.items], "amount_minor": total, "currency": inp.currency,
        "payment_ref": payment_ref, "eta": eta.isoformat(timespec="minutes"), "status": "paid",
        "plan_id": inp.plan_id, "created_at": ctx.now.isoformat(timespec="seconds")})
    return {"order_id": order_id, "payment_ref": payment_ref, "amount_minor": total,
            "eta": eta.isoformat(timespec="minutes"), "simulated_merchant": True, "payment_mode": "test"}


def refund(ctx: Ctx, inp: RefundInput) -> dict:
    order = ctx.store.get_record(ctx.household_id, "order", inp.order_id)
    if order is None:
        raise NotFound(f"Order {inp.order_id} not found.")
    if order.get("status") == "refunded":
        raise InvalidInput(f"Order {inp.order_id} was already refunded.")
    ref = ctx.adapters.payments.refund(order["payment_ref"], order["amount_minor"], inp.idempotency_key)
    order.update({"status": "refunded", "refund_ref": ref})
    ctx.store.put_record(ctx.household_id, "order", inp.order_id, order)
    return {"refund_ref": ref, "amount_minor": order["amount_minor"]}
