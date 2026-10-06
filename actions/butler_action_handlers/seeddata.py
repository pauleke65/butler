"""Simulated catalogue and provider data, loaded from ``seed/`` (or ``BUTLER_SEED_DIR``)."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


def seed_dir() -> Path:
    env = os.environ.get("BUTLER_SEED_DIR")
    if env:
        return Path(env)
    bundled = Path(__file__).parent / "data"
    if bundled.is_dir():
        return bundled
    for parent in Path(__file__).resolve().parents:
        if (parent / "seed" / "catalog.json").exists():
            return parent / "seed"
    raise FileNotFoundError("seed/catalog.json not found; set BUTLER_SEED_DIR")


@lru_cache(maxsize=4)
def _load(name: str, directory: str) -> Any:
    return json.loads((Path(directory) / name).read_text())


def catalog() -> list[dict[str, Any]]:
    return _load("catalog.json", str(seed_dir()))


def catalog_by_sku() -> dict[str, dict[str, Any]]:
    return {p["sku"]: p for p in catalog()}


def providers() -> list[dict[str, Any]]:
    return _load("providers.json", str(seed_dir()))


def providers_by_id() -> dict[str, dict[str, Any]]:
    return {p["provider_id"]: p for p in providers()}
