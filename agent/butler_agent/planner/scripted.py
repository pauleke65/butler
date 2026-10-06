"""ScriptedPlanner: the deterministic offline planner (LLM_MODE=offline).

It reproduces the golden demo on the fake adapters: it is "an LLM that always makes the same good decisions",
and every side effect goes through the same wrapper/Gateway as the real planner.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from butler_contracts.models import Need

from ..context import ActResult, RunContext
from ..guard import RunLimitExceeded
from .facts import Facts, derive, when_phrase
from .shopping import choose_product, money

log = logging.getLogger("butler.planner")

CAPABILITY_ORDER = ["messages", "calendar", "supplies", "services", "context"]
SIGN_OFF = "— sent by Butler for {host}"
SNACK_WORDS = ("snack", "nibbles", "appetizer", "appetiser", "starter", "platter", "canap", "finger food")
SERVICE_WORDS = {"cleaning": ("clean", "tidy", "maid"), "ride": ("ride", "taxi", "airport", "lift"),
                 "repair": ("repair", "fix", "plumber", "broken"), "pet_care": ("pet", "dog", "cat", "sitter", "walker")}
SERVICE_QUESTION = {"cleaning": "Which cleaner should I book?", "ride": "Which ride should I book?",
                    "repair": "Which repair service should I book?", "pet_care": "Which pet carer should I book?"}
GENERIC_WORDS = {"household", "stuff", "things", "supplies", "basics", "essentials", "items", "everything", "some", "the", "a"}
ITEM_PREFIX = re.compile(r"(?:low on|out of|run(?:ning)? out of|need(?: more)?|more|restock(?:ing)?)\s+(.*)$", re.IGNORECASE)


def _terminal(need: Need) -> bool:
    return need.status in ("done", "needs_you", "blocked", "skipped")


def _reasoning(reasons: list[str], context: list[str], alternatives: list[dict[str, str]] | None = None,
               confidence: float = 0.85) -> dict[str, Any]:
    return {"reasons": reasons[:3], "context_used": context, "alternatives": (alternatives or [])[:3],
            "confidence": confidence}


def _clock(dt: datetime) -> str:
    return dt.strftime("%I:%M %p").lstrip("0").replace(":00", "")


def _slot_label(dt: datetime) -> str:
    return f"{dt.strftime('%a')} {_clock(dt)}"


class ScriptedPlanner:
    def run(self, ctx: RunContext) -> None:
        plan = ctx.plan()
        now = ctx.now()
        hh = ctx.store.get_household(ctx.household_id)
        tz = hh.timezone if hh else "America/New_York"
        facts = derive(plan, ctx.store.list_contacts(ctx.household_id), ctx.store.list_members(ctx.household_id), tz, now)
        steps = _Steps(ctx, facts)
        try:
            for need in sorted(plan.needs, key=lambda n: CAPABILITY_ORDER.index(n.capability)):
                if not _terminal(need):
                    self._run_need(steps, need)
        except RunLimitExceeded as e:
            log.warning("run limit: %s", e)
            ctx.finalize(ctx.run_limit_reason())
            return
        ctx.finalize()
        ctx.finish(f"Worked through {len(plan.needs)} needs for {plan.title}.")

    def _run_need(self, steps: _Steps, need: Need) -> None:
        handler = getattr(steps, f"cap_{need.capability}", None)
        try:
            if handler is None:
                steps.ctx.set_need(need.need_id, "blocked", "I'm not sure how to handle this one yet.")
            else:
                handler(need)
        except RunLimitExceeded:
            raise
        except Exception:
            log.exception("need %s failed", need.need_id)
            steps.ctx.set_need(need.need_id, "blocked", "Something went wrong with this one. Ask me to try again.")


class _Steps:
    """One method per capability; each leaves its need in a terminal state."""

    def __init__(self, ctx: RunContext, facts: Facts):
        self.ctx, self.facts = ctx, facts
        self.kind = facts.plan.kind
        self.title = facts.plan.title

    # ── shared helpers ────────────────────────────────────────────────
    def _stamp(self) -> str:
        return _clock(self.ctx.now().astimezone(ZoneInfo(self.facts.tz)))

    def _cap(self, tool: str) -> int | None:
        caps = [r.params["cap_minor"] for r in self.ctx.store.list_rules(self.ctx.household_id, active_only=True)
                if r.template == "spend_cap" and tool in r.params.get("tools", [])]
        return min(caps) if caps else None

    def _merchant_preference(self, category: str) -> tuple[str | None, str | None]:
        """(merchant, context line) from learned preferences, else from past executed orders."""
        pref = self.ctx.get_preferences([f"merchant:{category}"]).get(f"merchant:{category}")
        if pref:
            return pref, f"preference: {pref} for {category}"
        counts: dict[str, int] = {}
        for r in self.ctx.store.list_receipts(self.ctx.household_id, limit=200):
            a = r.action
            if r.status == "executed" and a.tool == "Supplies___checkout" and a.args.get("category") == category:
                counts[a.args.get("merchant", "")] = counts.get(a.args.get("merchant", ""), 0) + 1
        if not counts:
            return None, None
        merchant = max(counts, key=lambda m: counts[m])
        return merchant, f"history: {counts[merchant]} earlier {category} orders from {merchant}"

    def _fail_note(self, res: ActResult) -> str:
        return re.sub(r"^FAILED:\s*", "", res.text)[:150] or "That didn't work."

    def _settle(self, need: Need, res: ActResult, *, done_note: str, tool: str, question: str, summary: str,
                title: str, subtitle: str, price_minor: int) -> bool:
        """Turn an action outcome into the need's final state. True when the action executed."""
        ctx = self.ctx
        if res.kind == "executed":
            ctx.set_need(need.need_id, "done", done_note)
            return True
        if res.kind == "ask":
            rule = res.denied_rule or {}
            ctx.request_decision(
                need.need_id, "approve_action", question,
                [{"title": title, "subtitle": subtitle, "price": {"amount_minor": price_minor, "currency": "USD"},
                  "tradeoff": f"Held because you said: {rule.get('rule_text', 'ask first')}", "simulated": True,
                  "action_draft": {"tool": tool, "args": res.args, "summary": summary}}],
                reason_held={"rule_id": rule["rule_id"], "rule_text": rule["rule_text"]} if rule.get("rule_id") else None)
        elif res.kind == "never":
            text = (res.denied_rule or {}).get("rule_text", "a rule you set")
            ctx.set_need(need.need_id, "skipped", f"Not allowed by your rule: {text}")
        elif res.kind == "retry_blocked":
            ctx.set_need(need.need_id, "blocked", "Already denied once; waiting for your answer.")
        else:
            ctx.set_need(need.need_id, "blocked", self._fail_note(res))
        return False

    # ── messages ──────────────────────────────────────────────────────
    def cap_messages(self, need: Need) -> None:
        f, ctx = self.facts, self.ctx
        if not f.audience:
            status, note = ("skipped", "No one to message.") if self.kind in ("away", "running_low") else \
                ("blocked", "I don't know who to message. Tell me their names.")
            ctx.set_need(need.need_id, status, note)
            return
        names = " and ".join(c.first_name for c in f.audience) if len(f.audience) <= 2 else "everyone"
        starts = f.starts
        if self.kind == "hosting":
            when = when_phrase(starts, ctx.now()) if starts else "soon"
            what = "dinner" if f.mentions("dinner") else "a get-together"
            subject, kind = f"You're invited: {what} {when}", "invite"
            body = (f"Hi {names},\n\nI'm having people over for {what} {when} and would love you to come. "
                    "Let me know if you can make it.\n\n" + SIGN_OFF.format(host=f.host))
            reasons = [f"you asked me to invite {self._audience_phrase()}", "invites work best when they go out early"]
        else:
            span = (f"from {starts.strftime('%A')} to {f.ends.strftime('%A')}" if starts and f.ends
                    else f"on {starts.strftime('%A')}" if starts else "soon")
            subject, kind = f"{f.host} will be away {span}", "notice"
            body = (f"Hi {names},\n\n{f.host} will be away {span}. Please make yourselves at home, "
                    "and I'm arranging a few supplies so the house is stocked.\n\n" + SIGN_OFF.format(host=f.host))
            reasons = ["you told me you're away and who is staying", "a heads-up avoids surprises"]
        res = ctx.act("Messages___send_email", {"recipient_contact_ids": [c.contact_id for c in f.audience],
                                                "subject": subject, "body_text": body, "kind": kind},
                      need_id=need.need_id, reasoning=_reasoning(reasons, [f"contacts: {len(f.audience)} resolved from your words"]))
        count = len(f.audience)
        mismatch = f" (you said {f.stated_count})" if f.stated_count and f.stated_count != count else ""
        self._settle(need, res, done_note=f"Sent to {count} {'person' if count == 1 else 'people'}{mismatch} at {self._stamp()}",
                     tool="Messages___send_email", question="OK to send that message?", summary=f"Email {names}",
                     title=f"Email {names}", subtitle=subject, price_minor=0)

    def _audience_phrase(self) -> str:
        tags = {t for c in self.facts.audience for t in (c.tags or [])}
        shared = [t for t in tags if all(t in (c.tags or []) for c in self.facts.audience)]
        return f"the {shared[0].replace('-', ' ')}" if shared and len(self.facts.audience) > 1 else \
            ", ".join(c.first_name for c in self.facts.audience)

    # ── calendar ──────────────────────────────────────────────────────
    def cap_calendar(self, need: Need) -> None:
        f, ctx = self.facts, self.ctx
        if f.starts is None:
            ctx.set_need(need.need_id, "skipped" if self.kind == "running_low" else "blocked",
                         "No date to put on the calendar." if self.kind != "running_low" else "Nothing to schedule.")
            return
        end = f.ends or f.starts + timedelta(hours=3)
        listed = ctx.act("Calendar___list_events", {"from": f.starts.isoformat(), "to": end.isoformat()},
                         need_id=need.need_id)
        busy = [e for e in (listed.data or {}).get("events", []) if e.get("butler_owner") == "human"] if listed.ok else []
        context = [f"calendar: {when_phrase(f.starts, ctx.now())} " + ("has a conflict" if busy else "is free")]
        attendees = [c.contact_id for c in f.audience] if self.kind == "hosting" else []
        res = ctx.act("Calendar___create_event",
                      {"title": self.title, "start": f.starts.isoformat(), "end": end.isoformat(),
                       **({"attendee_contact_ids": attendees} if attendees else {}),
                       "description": f"Organised by Butler: {f.situation}"},
                      need_id=need.need_id,
                      reasoning=_reasoning(["it keeps the plan visible on your calendar"], context))
        note = f"Added to your calendar for {when_phrase(f.starts, ctx.now())}" + (" (it overlaps something)" if busy else "")
        self._settle(need, res, done_note=note, tool="Calendar___create_event", question="OK to add that to your calendar?",
                     summary=f"Add {self.title} to your calendar", title=self.title, subtitle=when_phrase(f.starts, ctx.now()),
                     price_minor=0)

    # ── supplies ──────────────────────────────────────────────────────
    def cap_supplies(self, need: Need) -> None:
        if self.kind == "hosting":
            self._guest_supplies(need, people=len(self.facts.audience) + 1, deadline=self.facts.starts,
                                 deadline_phrase="after the party", who="your guests")
        elif self.kind == "away":
            parents = max(len(self.facts.audience), 1)
            end_of_day = datetime.combine(self.facts.starts.date(), time(23, 59), self.facts.starts.tzinfo) \
                if self.facts.starts else None
            self._guest_supplies(need, people=parents, deadline=end_of_day, deadline_phrase="after you leave",
                                 who="the people staying", weekend=True)
        else:
            self._reorder(need)

    def _guest_supplies(self, need: Need, *, people: int, deadline: datetime | None, deadline_phrase: str, who: str,
                        weekend: bool = False) -> None:
        query = "drinks for the weekend" if weekend else f"drinks bundle for {people}"
        bought = self._purchase(need, query=query, category="drinks", people=people, deadline=deadline,
                                deadline_phrase=deadline_phrase, what="drinks", who=who)
        if bought and self.kind == "hosting" and self.facts.mentions(*SNACK_WORDS):
            self._purchase(need, query=f"snack platter for {people}", category="groceries", people=people,
                           deadline=deadline, deadline_phrase=deadline_phrase, what="snacks", who=who, final=False)

    def _purchase(self, need: Need, *, query: str, category: str, people: int, deadline: datetime | None,
                  deadline_phrase: str, what: str, who: str, final: bool = True) -> bool:
        ctx = self.ctx
        iso = deadline.isoformat() if deadline else None
        on_time: dict[str, Any] | None = None
        if iso:
            r = ctx.act("Supplies___search_products", {"query": query, "category": category, "deliver_by": iso, "max_results": 5},
                        need_id=need.need_id)
            on_time = r.data if r.ok else None
        every = ctx.act("Supplies___search_products", {"query": query, "category": category, "max_results": 5}, need_id=need.need_id)
        if not every.ok or not (every.data or {}).get("products"):
            ctx.set_need(need.need_id, "blocked", f"I couldn't find {what} to order.")
            return False
        products = every.data["products"]
        on_time_skus = {p["sku"] for p in on_time["products"]} if on_time else {p["sku"] for p in products}
        cap = self._cap("Supplies___checkout")
        merchant, pref_line = self._merchant_preference(category)
        choice = choose_product(products, on_time_skus, people=people, cap_minor=cap, preferred_merchant=merchant,
                                deadline_phrase=deadline_phrase)
        pick = choice.chosen
        if pick is None:
            ctx.set_need(need.need_id, "blocked", f"Nothing found that serves {people} people.")
            return False
        if iso and not choice.on_time_exists:
            ctx.set_need(need.need_id, "blocked", f"Nothing for {people} people arrives in time ({deadline_phrase.replace('after', 'before')}).")
            return False
        price = pick["unit_price_minor"]
        reasons = [f"you have {people - 1} guests coming" if self.kind == "hosting" else f"it stocks the house for {who}",
                   f"it arrives {pick['delivery_label']}" + (f", {deadline_phrase.replace('after', 'before')}" if deadline else ""),
                   f"it is within your {cap // 100} dollar limit" if cap and price <= cap else f"it costs {money(price)}"]
        context = [f"plan: {self.title}", f"people: {people}"]
        if pref_line:
            context.append(pref_line)
        res = ctx.act("Supplies___checkout",
                      {"merchant": pick["merchant"], "items": [{"sku": pick["sku"], "qty": 1}], "amount_minor": price,
                       "currency": "USD", "category": category, **({"deliver_by": iso} if iso else {})},
                      need_id=need.need_id, reasoning=_reasoning(reasons, context, choice.alternatives))
        done = f"Bought {what} from {pick['merchant']}, {money(price)}, arriving {pick['delivery_label']}"
        ok = self._settle(need, res, done_note=done if final else need_note(ctx, need, done), tool="Supplies___checkout",
                          question=f"OK to buy {what} for {money(price)}?", summary=f"Buy {what} for {who}, {money(price)}",
                          title=f"Buy {what} for {who}", subtitle=f"{pick['merchant']} · arrives {pick['delivery_label']}",
                          price_minor=price)
        if ok and res.receipt is not None:
            ctx.note_preference(f"merchant:{category}", pick["merchant"], res.receipt.action_id)
        return ok

    # reorder (running low)
    def _item_phrases(self) -> list[str]:
        text = self.facts.situation
        m = ITEM_PREFIX.search(text)
        tail = m[1] if m else ""
        parts = re.split(r",|\band\b|&", tail)
        phrases = [p.strip(" .!?") for p in parts if p.strip(" .!?")]
        return [p for p in phrases if set(p.lower().split()) - GENERIC_WORDS][:4]

    def _reorder(self, need: Need) -> None:
        ctx = self.ctx
        wanted: list[tuple[dict[str, Any], int]] = []
        phrases = self._item_phrases()
        history_note = self._history_line()
        if phrases:
            for phrase in phrases:
                found = ctx.act("Supplies___search_products", {"query": phrase, "max_results": 3}, need_id=need.need_id)
                items = (found.data or {}).get("products", []) if found.ok else []
                if items and all(items[0]["sku"] != w[0]["sku"] for w in wanted):
                    wanted.append((items[0], 1))
        else:
            wanted = self._reorder_last_household_order(need)
        if not wanted:
            ctx.set_need(need.need_id, "blocked", "I couldn't tell what to reorder. Which items are low?")
            return
        groups: dict[tuple[str, str], list[tuple[dict[str, Any], int]]] = {}
        for product, qty in wanted:
            groups.setdefault((product["merchant"], product["category"]), []).append((product, qty))
        notes: list[str] = []
        for (merchant, category), items in groups.items():
            total = sum(p["unit_price_minor"] * q for p, q in items)
            names = ", ".join(p["name"] for p, _ in items)
            pref, pref_line = self._merchant_preference(category)
            cap = self._cap("Supplies___checkout")
            reasons = [f"you're running low on {names.lower()}",
                       "it's the same merchant as your earlier orders" if pref == merchant else "it's the cheapest match",
                       f"it is within your {cap // 100} dollar limit" if cap and total <= cap else f"it costs {money(total)}"]
            res = ctx.act("Supplies___checkout",
                          {"merchant": merchant, "items": [{"sku": p["sku"], "qty": q} for p, q in items], "amount_minor": total,
                           "currency": "USD", "category": category},
                          need_id=need.need_id,
                          reasoning=_reasoning(reasons, [c for c in (history_note, pref_line) if c]))
            ok = self._settle(need, res, done_note="", tool="Supplies___checkout", question=f"OK to reorder {names.lower()} for {money(total)}?",
                              summary=f"Reorder {names}, {money(total)}", title=f"Reorder {names}",
                              subtitle=f"{merchant} · arrives {items[0][0]['delivery_label']}", price_minor=total)
            if ok:
                notes.append(f"Reordered {names.lower()} from {merchant}, {money(total)}")
                if res.receipt is not None:
                    ctx.note_preference(f"merchant:{category}", merchant, res.receipt.action_id)
            else:
                return
        ctx.set_need(need.need_id, "done", "; ".join(notes))

    def _history_line(self) -> str | None:
        recent = [r for r in self.ctx.store.list_receipts(self.ctx.household_id, limit=200)
                  if r.status == "executed" and r.action.tool == "Supplies___checkout"
                  and r.action.args.get("category") in ("household", "groceries", "toiletries")]
        if not recent:
            return None
        return f"history: {len(recent)} earlier household orders, latest {recent[0].created_at[:10]}"

    def _reorder_last_household_order(self, need: Need) -> list[tuple[dict[str, Any], int]]:
        from butler_action_handlers import seeddata  # simulated catalogue names (scripted planner only)

        last = next((r for r in self.ctx.store.list_receipts(self.ctx.household_id, limit=200)
                     if r.status == "executed" and r.action.tool == "Supplies___checkout"
                     and r.action.args.get("category") == "household"), None)
        if last is None:
            return []
        by_sku = seeddata.catalog_by_sku()
        wanted: list[tuple[dict[str, Any], int]] = []
        for item in last.action.args.get("items", []):
            name = by_sku.get(item["sku"], {}).get("name")
            if not name:
                continue
            found = self.ctx.act("Supplies___search_products", {"query": name, "category": "household", "max_results": 3},
                                 need_id=need.need_id)
            products = (found.data or {}).get("products", []) if found.ok else []
            match = next((p for p in products if p["sku"] == item["sku"]), None)
            if match:
                wanted.append((match, int(item.get("qty", 1))))
        return wanted

    # ── services ──────────────────────────────────────────────────────
    def _service_type(self, need: Need) -> str:
        low = f"{need.label} {self.facts.situation}".lower()
        return next((t for t, words in SERVICE_WORDS.items() if any(w in low for w in words)), "cleaning")

    def cap_services(self, need: Need) -> None:
        ctx, f = self.ctx, self.facts
        stype = self._service_type(need)
        day = (f.starts or ctx.now()).astimezone(ZoneInfo(f.tz)).date().isoformat()
        res = ctx.act("Services___search_providers", {"service_type": stype, "date": day}, need_id=need.need_id)
        providers = (res.data or {}).get("providers", []) if res.ok else []
        if not providers:
            ctx.set_need(need.need_id, "blocked", f"No {stype.replace('_', ' ')} is available in time.")
            return
        cheapest = min(p["price_minor"] for p in providers)
        priciest = max(p["price_minor"] for p in providers)
        slots = {p["provider_id"]: datetime.fromisoformat(p["slot_start"]) for p in providers}
        earliest, latest = min(slots.values()), max(slots.values())
        options = []
        for p in providers:
            slot = slots[p["provider_id"]]
            tags = [t for ok, t in ((p["price_minor"] == cheapest, "cheapest"), (p["price_minor"] == priciest, "priciest"),
                                    (p["rating"] == max(x["rating"] for x in providers), "top rated"),
                                    (slot == earliest and earliest != latest, "earliest slot"),
                                    (slot == latest and earliest != latest, "latest slot")) if ok]
            tradeoff = (", ".join(tags).capitalize() if tags else "A solid middle option") + f", {_slot_label(slot)}"
            args = {"provider_id": p["provider_id"], "service_type": stype, "slot_start": p["slot_start"],
                    "amount_minor": p["price_minor"], "currency": p["currency"], "plan_id": ctx.plan_id,
                    "need_id": need.need_id, "correlation_id": ctx.correlation_id,
                    "idempotency_key": f"{ctx.plan_id}:{need.need_id}:book_service:{p['provider_id']}"}
            options.append({"title": p["name"], "subtitle": f"{_slot_label(slot)} · {p['rating']} stars",
                            "price": {"amount_minor": p["price_minor"], "currency": p["currency"]}, "tradeoff": tradeoff,
                            "simulated": True,
                            "action_draft": {"tool": "Services___book_service", "args": args,
                                             "summary": f"Book {p['name']}, {_slot_label(slot)}, {money(p['price_minor'])}"}})
        if len(options) == 1:
            ctx.request_decision(need.need_id, "approve_action", f"OK to book {options[0]['title']}?", options)
        else:
            ctx.request_decision(need.need_id, "choose_option", SERVICE_QUESTION[stype], options, default_index=0)

    # ── context ───────────────────────────────────────────────────────
    def cap_context(self, need: Need) -> None:
        f, ctx = self.facts, self.ctx
        day = (f.starts or ctx.now()).astimezone(ZoneInfo(f.tz)).date().isoformat()
        res = ctx.act("Context___get_weather", {"date": day}, need_id=need.need_id)
        if res.ok:
            ctx.set_need(need.need_id, "done", f"Forecast: {(res.data or {}).get('summary', 'unknown')}")
        else:
            ctx.set_need(need.need_id, "blocked", "I couldn't get the forecast.")


def need_note(ctx: RunContext, need: Need, extra: str) -> str:
    """Append to a need's existing note (multi-step supplies needs)."""
    current = ctx.need(need.need_id).note
    return f"{current}; {extra}" if current else extra


