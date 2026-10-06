"""Pure product-selection logic for the scripted planner (compare, reject with a reason, pick)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


def capacity(name: str) -> int | None:
    """How many people a bundle serves, from its name ("... for 7", "3 people")."""
    m = re.search(r"\bfor (\d+)\b|\b(\d+) people\b", name.lower())
    return int(m[1] or m[2]) if m else None


def whole_dollars(amount_minor: int) -> str:
    """Adjective form for "over your 50 dollar limit"."""
    d, c = divmod(amount_minor, 100)
    return f"{d} dollar" if c == 0 else f"{d} dollars {c}"


def money(amount_minor: int) -> str:
    d, c = divmod(amount_minor, 100)
    if c == 0:
        return f"{d} dollar" if d == 1 else f"{d} dollars"
    return f"{d} dollars {c}"


@dataclass
class Choice:
    chosen: dict[str, Any] | None
    reasons: list[str] = field(default_factory=list)
    alternatives: list[dict[str, str]] = field(default_factory=list)
    fallback: bool = False
    on_time_exists: bool = True


def _label(p: dict[str, Any]) -> str:
    return f"{p['merchant']} {p['name']} ({money(p['unit_price_minor'])})"


def choose_product(all_products: list[dict[str, Any]], on_time_skus: set[str], *, people: int | None,
                   cap_minor: int | None, preferred_merchant: str | None, deadline_phrase: str) -> Choice:
    """Pick one product. Rejections carry the reason spoken in the receipt (late, over the cap, too small)."""
    candidates = [p for p in all_products if people is None or (capacity(p["name"]) or 0) >= people]
    verdicts: list[tuple[dict[str, Any], str | None]] = []
    for p in candidates:
        if p["sku"] not in on_time_skus:
            day = p["delivery_label"].split()[0]
            verdicts.append((p, f"Arrives {day}, {deadline_phrase}"))
        elif cap_minor is not None and p["unit_price_minor"] > cap_minor:
            verdicts.append((p, f"Over your {whole_dollars(cap_minor)} limit"))
        else:
            verdicts.append((p, None))
    eligible = [p for p, why in verdicts if why is None]
    fallback = not eligible
    pool = eligible or [p for p in candidates if p["sku"] in on_time_skus] or candidates
    if not pool:
        return Choice(None)

    def rank(p: dict[str, Any]) -> tuple[int, int, int]:
        waste = (capacity(p["name"]) or 0) - (people or 0)
        return (0 if preferred_merchant and p["merchant"] == preferred_merchant else 1, waste, p["unit_price_minor"])

    chosen = min(pool, key=rank)
    reasons = {p["sku"]: why for p, why in verdicts if why}
    alternatives = [{"option": _label(p), "rejected_because": reasons.get(p["sku"], "Costs more or is a worse fit")}
                    for p in candidates if p["sku"] != chosen["sku"]][:3]
    return Choice(chosen, [], alternatives, fallback, any(p["sku"] in on_time_skus for p in candidates))
