"""Rule drafting (contracts §5 draft_rule, §12.3): correction -> ``RuleDraft`` (template + params, never Cedar).

``PatternRuleDrafter`` is the offline implementation; ``LLMRuleDrafter`` (Bedrock tool-use structured output)
lives in ``llm_drafter.py``. Both return ``template="unsupported"`` when no template fits.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Protocol

from butler_contracts.models import Contact, Receipt, Rule, RuleDraft
from butler_rules import TEMPLATES

SUPPORTED_SENTENCE = ("I can make rules about spending limits, asking before a type of purchase, asking before "
                      "booking services, asking before messaging new people, or never messaging a specific person.")

CATEGORY_WORDS = {
    "drinks": ("drinks", "drink", "beverages", "beverage", "soda", "sodas", "alcohol", "wine", "beer", "juice"),
    "groceries": ("groceries", "grocery", "food", "snacks"),
    "household": ("household", "household supplies", "cleaning supplies", "supplies"),
    "toiletries": ("toiletries", "toiletry"),
    "gifts": ("gifts", "gift", "presents", "flowers"),
    "other": ("other things", "miscellaneous"),
}
TOOL_PHRASES: list[tuple[str, str]] = [
    (r"book(?:ing)?\s+(?:a\s+|any\s+|a\s+new\s+)?(?:services?|anything|appointments?|cleaners?)", "Services___book_service"),
    (r"refund(?:ing|s)?\b", "Supplies___refund"),
    (r"cancel(?:l)?(?:ing)?\s+(?:a\s+|any\s+)?bookings?", "Services___cancel_booking"),
    (r"(?:sending|send)\s+(?:an?\s+|any\s+)?e?mails?|emailing", "Messages___send_email"),
    (r"(?:buy(?:ing)?|purchas(?:e|ing)|order(?:ing)?|check(?:ing)?\s*out)\s+(?:anything|stuff|things|online)|checkout", "Supplies___checkout"),
    (r"(?:delet(?:e|ing)|remov(?:e|ing)|cancel(?:l)?(?:ing)?)\s+(?:my\s+|any\s+)?(?:calendar\s+)?events?", "Calendar___delete_event"),
    (r"(?:chang(?:e|ing)|updat(?:e|ing)|mov(?:e|ing)|edit(?:ing)?)\s+(?:my\s+|any\s+)?(?:calendar\s+)?events?", "Calendar___update_event"),
    (r"(?:creat(?:e|ing)|add(?:ing)?)\s+(?:calendar\s+)?events?", "Calendar___create_event"),
]
ASK_RE = re.compile(r"\b(?:ask|check with|confirm with|run (?:it|that|them) by|get my (?:ok|okay|approval|permission)|tell me)\b")
WITHOUT_ASK_RE = re.compile(r"\b(?:without (?:asking|checking|telling|my (?:ok|okay|approval|permission))|unless i (?:say|approve|ok))")
NON_CONTACT_RE = re.compile(r"\b(?:strangers?|unknown (?:people|contacts|numbers)|new people|non[- ]?contacts?|"
                            r"(?:anyone|people|someone)(?: who)?(?: is(?:n'?t| not)| are(?:n'?t| not)| i don'?t know| not)(?: in| a| one of)?(?: my)?(?: saved)?(?: contacts?)?|"
                            r"people i don'?t know|not in my contacts)\b")
MESSAGE_VERBS = r"(?:e-?mail(?:ing)?|messag(?:e|ing)|text(?:ing)?|contact(?:ing)?|writ(?:e|ing) to|send(?:ing)? (?:any )?(?:e?mails?|messages?|texts?) to)"
AMOUNT_RE = re.compile(r"(?:\$\s?|usd\s?)(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd)\b")
SPEND_WORDS = re.compile(r"\b(?:spend|spending|spent|spends|limit|cap|budget|over|above|more than|exceed(?:s|ing)?|costs?)\b")
LIMIT_CHANGE_RE = re.compile(r"\b(?:rais(?:e|ing)|low(?:er|ering)|increas(?:e|ing)|decreas(?:e|ing)|reduc(?:e|ing)|chang(?:e|ing)|"
                             r"set|mak(?:e|ing)|bump|up|put)\b.*\b(?:limit|cap|budget|threshold)\b")


@dataclass
class DraftContext:
    """What a drafter may look at: the household's contacts and rules, the referenced receipt and base rule."""

    contacts: list[Contact] = field(default_factory=list)
    rules: list[Rule] = field(default_factory=list)
    receipt: Receipt | None = None
    base_rule: Rule | None = None


class RuleDrafter(Protocol):
    def draft(self, correction: str, ctx: DraftContext) -> RuleDraft: ...


def unsupported(confidence: float = 0.0) -> RuleDraft:
    return RuleDraft(template="unsupported", params={}, text="", effect="ask_first", confidence=confidence)


def make_draft(template: str, params: dict, confidence: float = 0.92) -> RuleDraft:
    spec = TEMPLATES[template]  # type: ignore[index]
    return RuleDraft(template=template, params=params, text=spec.text(params), effect=spec.effect, confidence=confidence)  # type: ignore[arg-type]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("’", "'")).strip(" .!?")


def _has(text: str, phrase: str) -> bool:
    return re.search(rf"\b{re.escape(phrase)}\b", text) is not None


def _amount_minor(text: str) -> int | None:
    m = AMOUNT_RE.search(text)
    if not m:
        return None
    return round(float((m[1] or m[2]).replace(",", "")) * 100)


class PatternRuleDrafter:
    """Deterministic keyword/regex drafter for the offline mode and tests."""

    def draft(self, correction: str, ctx: DraftContext) -> RuleDraft:
        text = _norm(correction)
        for attempt in (self._non_contact, self._never_contact, self._protect_events, self._spend_cap,
                        self._ask_category, self._tool_rule):
            draft = attempt(text, ctx)
            if draft is not None:
                return draft
        return unsupported()

    def _non_contact(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        if NON_CONTACT_RE.search(text) and re.search(MESSAGE_VERBS + r"|\bsend\b", text):
            return make_draft("ask_non_contact", {})
        return None

    def _resolve_contacts(self, text: str, contacts: list[Contact]) -> list[Contact]:
        named = [c for c in contacts if _has(text, c.first_name.lower()) or _has(text, c.name.lower())]
        if named:
            return named
        found: dict[str, Contact] = {}
        for c in contacts:
            for tag in c.tags or []:
                if _has(text, tag.replace("-", " ")) or _has(text, tag.rstrip("s")) or _has(text, tag):
                    found[c.contact_id] = c
        return list(found.values())

    def _never_contact(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        if not re.search(rf"(?:\bnever\b|\bdon'?t\b|\bdo not\b|\bstop\b|\bno more\b|\bquit\b).*{MESSAGE_VERBS}", text):
            return None
        if ASK_RE.search(text) or WITHOUT_ASK_RE.search(text):
            return None
        people = self._resolve_contacts(text, ctx.contacts)
        if len(people) != 1:
            return unsupported()  # nobody, or a group: the template covers exactly one contact
        return make_draft("never_contact", {"contact_id": people[0].contact_id, "contact_name": people[0].first_name})

    def _protect_events(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        if re.search(r"\b(?:never|don'?t|do not|stop)\b.*\b(?:chang(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|mov(?:e|ing)|touch(?:ing)?|"
                     r"remov(?:e|ing)|mess(?:ing)? with)\b.*\b(?:my )?(?:calendar|events?|appointments?)\b", text):
            return make_draft("protect_human_events", {})
        return None

    def _spend_cap(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        amount = _amount_minor(text)
        if amount is None or not SPEND_WORDS.search(text):
            return None
        is_change = bool(LIMIT_CHANGE_RE.search(text)) or ctx.base_rule is not None and ctx.base_rule.template == "spend_cap"
        if re.search(r"\bnever\b", text) and not is_change:
            return unsupported()  # a hard "never spend" is not an ask-first cap
        if not (is_change or ASK_RE.search(text) or WITHOUT_ASK_RE.search(text) or re.search(r"\b(?:over|above|more than|exceed)", text)):
            return None
        tools = self._spend_tools(text, ctx)
        return make_draft("spend_cap", {"tools": tools, "cap_minor": amount})

    def _spend_tools(self, text: str, ctx: DraftContext) -> list[str]:
        if ctx.base_rule is not None and ctx.base_rule.template == "spend_cap":
            return list(ctx.base_rule.params["tools"])
        books = bool(re.search(r"\b(?:book|booking|bookings|services?)\b", text))
        buys = bool(re.search(r"\b(?:buy|buying|purchases?|orders?|ordering|shopping|checkout)\b", text))
        if books and not buys:
            return ["Services___book_service"]
        if buys and not books:
            return ["Supplies___checkout"]
        return ["Supplies___checkout", "Services___book_service"]

    def _category(self, text: str) -> str | None:
        for category, words in CATEGORY_WORDS.items():
            if any(_has(text, w) for w in sorted(words, key=len, reverse=True)):
                return category
        return None

    def _ask_category(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        buying = re.search(r"\b(?:buy|buying|bought|purchase|purchasing|order|ordering|shop|shopping|get|getting)\b", text)
        asks = ASK_RE.search(text) or WITHOUT_ASK_RE.search(text)
        category = self._category(text)
        if buying and asks and category:
            return make_draft("ask_category", {"category": category})
        return None

    def _tool_rule(self, text: str, ctx: DraftContext) -> RuleDraft | None:
        found = next(((m, t) for pattern, t in TOOL_PHRASES if (m := re.search(pattern, text))), None)
        if found is None:
            return None
        match, tool = found
        if re.match(r"\s+(?:from|at|on|with|by|that|which|containing|made)\b", text[match.end():]):
            return unsupported()  # "anything from <merchant>" is a merchant-level ask, not a tool-level one
        asks = ASK_RE.search(text) or WITHOUT_ASK_RE.search(text)
        if asks and re.search(r"\b(?:before|first|without)\b", text):
            return make_draft("ask_tool", {"tool": tool})
        if re.search(r"\balways ask\b", text):
            return make_draft("ask_tool", {"tool": tool})
        if re.search(r"\b(?:never|don'?t|do not|stop|no more)\b", text):
            return make_draft("never_tool", {"tool": tool})
        return None
