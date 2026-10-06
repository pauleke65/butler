"""Versioned prompt files under ``prompts/`` (contracts §12). ``load`` returns (text, version)."""
from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

_HEADER = re.compile(r"^<!--.*?version:\s*(\d+).*?-->\s*", re.DOTALL)


def prompts_dir() -> Path:
    env = os.environ.get("PROMPTS_DIR")
    if env:
        return Path(env)
    for parent in Path(__file__).resolve().parents:
        if (parent / "prompts").is_dir():
            return parent / "prompts"
    raise FileNotFoundError("prompts/ not found; set PROMPTS_DIR")


@lru_cache(maxsize=16)
def load(name: str, version: int = 1) -> tuple[str, int]:
    raw = (prompts_dir() / f"{name}.v{version}.md").read_text()
    m = _HEADER.match(raw)
    return (raw[m.end():] if m else raw).strip(), int(m[1]) if m else version
