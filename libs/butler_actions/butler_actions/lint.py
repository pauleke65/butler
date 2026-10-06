"""Spoken-text lint (contracts §15): the Python port of lintSpoken."""
from __future__ import annotations

import re

MAX_WORDS = 35
MAX_SENTENCES = 2
_EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F2FF\U00002B00-\U00002BFF←-⇿]")
_MARKDOWN = re.compile(r"(\*\*|__|`|^#{1,6}\s|^\s*[-*•]\s|\[[^\]]*\]\([^)]*\)|\|)", re.MULTILINE)
_URL = re.compile(r"(https?://|www\.|\b\w+\.(com|org|net|io|app)\b)", re.IGNORECASE)
_ID = re.compile(r"\b(?:hh|mem|c|plan|need|dec|opt|act|rule|ord|bkg|evt|cor)_[0-9A-Za-z_]+\b|\b[0-9A-HJKMNP-TV-Z]{26}\b")
_JSON = re.compile(r"[{}]|\[\s*\"|\":")
_MONEY_SYMBOL = re.compile(r"[$£€]\s?\d|\d+\.\d{2}\b")
_ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}(T|\b)")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def sentences(text: str) -> list[str]:
    return [s for s in _SENTENCE_END.split(text.strip()) if s]


def lint_spoken(text: str) -> list[str]:
    """Return the violations of the §15 rules (empty list = clean). Never raises."""
    out: list[str] = []
    stripped = text.strip()
    if not stripped:
        return ["empty"]
    parts = sentences(stripped)
    if len(parts) > MAX_SENTENCES:
        out.append(f"more than {MAX_SENTENCES} sentences ({len(parts)})")
    words = len(stripped.split())
    if words > MAX_WORDS:
        out.append(f"more than {MAX_WORDS} words ({words})")
    if stripped.count("?") > 1 or ("?" in stripped and not stripped.endswith("?")):
        out.append("a question must be the single last sentence")
    checks = [
        (_MARKDOWN, "markdown or bullets"), (_EMOJI, "emoji"), (_URL, "URL"), (_ID, "ID"), (_JSON, "JSON"),
        (_MONEY_SYMBOL, "money must be spoken, like '42 dollars 50'"), (_ISO, "ISO date, say it relatively"),
    ]
    out += [label for rx, label in checks if rx.search(stripped)]
    return out
