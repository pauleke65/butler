"""ULID-style ids with a type prefix (contracts §1). Time-sortable, Crockford base32."""
from __future__ import annotations

import os
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def ulid(ts_ms: int | None = None) -> str:
    ts = int(time.time() * 1000) if ts_ms is None else ts_ms
    rand = int.from_bytes(os.urandom(10), "big")
    return _encode(ts, 10) + _encode(rand, 16)


def new_id(prefix: str, ts_ms: int | None = None) -> str:
    return f"{prefix}_{ulid(ts_ms)}"


PREFIXES = {
    "household": "hh", "member": "mem", "contact": "c", "plan": "plan", "need": "need",
    "decision": "dec", "option": "opt", "action": "act", "rule": "rule", "order": "ord",
    "booking": "bkg", "event": "evt", "correlation": "cor",
}


def deterministic_id(prefix: str, ts_ms: int, seed: str) -> str:
    """Time-sortable id whose random part derives from ``seed`` (idempotent seeding)."""
    import hashlib

    rand = int.from_bytes(hashlib.sha256(seed.encode()).digest()[:10], "big")
    return f"{prefix}_{_encode(ts_ms, 10)}{_encode(rand, 16)}"
