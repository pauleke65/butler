from action_fixtures import NOW
from butler_action_handlers import dispatch

DINNER_CREW = ["c_tolu", "c_sam", "c_ada", "c_chris", "c_maya", "c_dee"]


def err(res):
    assert res["ok"] is False
    return res["error"]["code"]


# ── dispatch envelope ──────────────────────────────────────────────────
def test_unknown_tool_and_invalid_input(run):
    assert err(run("Nope___x")) == "NOT_FOUND"
    assert err(run("Supplies___checkout", merchant="FreshCart")) == "INVALID_INPUT"  # missing fields


def test_idempotency_replay_returns_original_without_second_effect(store, adapters):
    event = {"idempotency_key": "plan:need:send_email:1", "correlation_id": "c", "recipient_contact_ids": ["c_tolu"],
             "subject": "Hi", "body_text": "Hello", "kind": "invite"}
    first = dispatch("Messages___send_email", dict(event), store=store, now=NOW, adapters=adapters)
    second = dispatch("Messages___send_email", dict(event), store=store, now=NOW, adapters=adapters)
    assert first == second and first["ok"]
    assert len(adapters.email.sent) == 1


def test_failed_calls_are_not_cached(run, adapters):
    bad = run("Messages___send_email", recipient_contact_ids=["c_nobody"], subject="s", body_text="b", kind="other")
    assert err(bad) == "INVALID_INPUT" and adapters.email.sent == []


def test_household_from_event_only_in_local_stage(store, adapters, monkeypatch):
    base = {"idempotency_key": "k", "correlation_id": "c", "date": "2026-10-16"}
    monkeypatch.setenv("STAGE", "demo")
    monkeypatch.setenv("HOUSEHOLD_ID", "hh_demo")
    ok = dispatch("Context___get_weather", {**base, "household_id": "hh_other"}, store=store, now=NOW, adapters=adapters)
    assert ok["ok"]  # household_id from tool input was ignored; hh_demo's location was used


# ── messages ───────────────────────────────────────────────────────────
def test_send_email_to_contacts_one_message_each(run, adapters):
    res = run("Messages___send_email", recipient_contact_ids=DINNER_CREW, subject="Dinner Friday", body_text="Come!\n\nBring nothing.",
              kind="invite", reasoning={"reasons": ["x"]})
    assert res["ok"] and len(res["data"]["message_ids"]) == 6
    assert res["data"]["sent_to"][0] == "Tolu"
    assert adapters.email.sent[0]["to"].startswith("butler.demo+tolu")


def test_send_email_requires_exactly_one_recipient_kind(run):
    args = {"subject": "s", "body_text": "b", "kind": "other"}
    assert err(run("Messages___send_email", **args)) == "INVALID_INPUT"
    assert err(run("Messages___send_email", recipient_contact_ids=["c_tolu"], recipient_email="a@b.co", **args)) == "INVALID_INPUT"


def test_send_email_address_needs_allowlist_in_sandbox(run, adapters, monkeypatch):
    args = {"subject": "s", "body_text": "b", "kind": "other"}
    assert err(run("Messages___send_email", recipient_email="stranger@example.org", **args)) == "UPSTREAM_UNAVAILABLE"
    monkeypatch.setenv("SES_ALLOWED_RECIPIENTS", "friend@example.org")
    assert run("Messages___send_email", recipient_email="friend@example.org", **args)["ok"]
    assert adapters.email.sent[-1]["to"] == "friend@example.org"
    monkeypatch.setenv("SES_SANDBOX", "false")
    assert run("Messages___send_email", recipient_email="stranger@example.org", **args)["ok"]


def test_send_email_body_limit(run):
    res = run("Messages___send_email", recipient_contact_ids=["c_tolu"], subject="s", body_text="x" * 2001, kind="other")
    assert err(res) == "INVALID_INPUT"


# ── calendar ───────────────────────────────────────────────────────────
def test_calendar_round_trip_and_records(run, store, adapters):
    created = run("Calendar___create_event", title="Dinner", start="2026-10-16T19:00:00-04:00", end="2026-10-16T22:00:00-04:00",
                  attendee_contact_ids=["c_tolu"])
    assert created["ok"]
    eid = created["data"]["event_id"]
    assert store.get_record("hh_demo", "event", eid)["butler_owner"] == "butler"
    assert adapters.calendar.events[eid]["attendees"] == ["butler.demo+tolu@example.com"]
    assert run("Calendar___update_event", event_id=eid, event_owner="butler", title="Dinner at mine")["ok"]
    assert adapters.calendar.events[eid]["title"] == "Dinner at mine"
    listed = run("Calendar___list_events", **{"from": "2026-10-16T00:00:00-04:00", "to": "2026-10-16T23:59:00-04:00"})
    assert [e["event_id"] for e in listed["data"]["events"]] == [eid]
    assert run("Calendar___delete_event", event_id=eid, event_owner="butler")["data"] == {"deleted": True}
    assert err(run("Calendar___delete_event", event_id=eid, event_owner="butler")) == "NOT_FOUND"


def test_owner_mismatch_is_rejected_both_ways(run):
    eid = run("Calendar___create_event", title="Mine", start="2026-10-16T19:00:00-04:00", end="2026-10-16T20:00:00-04:00")["data"]["event_id"]
    assert err(run("Calendar___update_event", event_id=eid, event_owner="human", title="x")) == "INVALID_INPUT"
    # a human event cannot be touched by claiming "butler"
    assert err(run("Calendar___delete_event", event_id="evt_human_dentist", event_owner="butler")) == "INVALID_INPUT"
    assert err(run("Calendar___update_event", event_id="evt_nope", event_owner="human")) == "NOT_FOUND"


def test_human_events_listed_with_owner(run):
    res = run("Calendar___list_events", **{"from": "2026-10-14T00:00:00-04:00", "to": "2026-10-14T23:00:00-04:00"})
    ev = res["data"]["events"]
    assert ev[0]["title"] == "Dentist" and ev[0]["butler_owner"] == "human"


def test_create_event_validates_times_and_attendees(run):
    assert err(run("Calendar___create_event", title="t", start="2026-10-16T20:00:00-04:00", end="2026-10-16T19:00:00-04:00")) == "INVALID_INPUT"
    assert err(run("Calendar___create_event", title="t", start="2026-10-16T19:00:00-04:00", end="2026-10-16T20:00:00-04:00",
                   attendee_contact_ids=["c_ghost"])) == "INVALID_INPUT"


# ── supplies ───────────────────────────────────────────────────────────
def test_search_drinks_ranks_party_bundles_first(run):
    res = run("Supplies___search_products", query="drinks bundle for 7", category="drinks")
    skus = [p["sku"] for p in res["data"]["products"]]
    assert skus[:3] == ["drk-party-7-budget", "drk-party-7", "drk-premium-7"]
    first = res["data"]["products"][1]
    assert first["simulated"] is True and first["delivery_label"] == "Friday 12-2 PM"
    assert first["delivery_eta"] == "2026-10-16T14:00-04:00"


def test_search_deliver_by_filters_late_items(run):
    res = run("Supplies___search_products", query="drinks bundle for 7", category="drinks", deliver_by="2026-10-16T19:00:00-04:00")
    skus = [p["sku"] for p in res["data"]["products"]]
    assert "drk-party-7-budget" not in skus and {"drk-party-7", "drk-premium-7"} <= set(skus)


def test_search_limits_to_five_and_free_text(run):
    assert len(run("Supplies___search_products", query="drinks", category="drinks", max_results=5)["data"]["products"]) == 5
    assert err(run("Supplies___search_products", query="x", max_results=9)) == "INVALID_INPUT"
    milk = run("Supplies___search_products", query="milk")["data"]["products"]
    assert milk[0]["sku"] == "grc-milk" and milk[0]["delivery_label"].startswith("Tomorrow")


def checkout_args(**over):
    base = {"merchant": "FreshCart", "items": [{"sku": "drk-party-7", "qty": 1}], "amount_minor": 4200,
            "currency": "USD", "category": "drinks"}
    return {**base, **over}


def test_checkout_happy_path_writes_order_and_charges(run, store, adapters):
    res = run("Supplies___checkout", **checkout_args(deliver_by="2026-10-16T19:00:00-04:00"))
    assert res["ok"], res
    d = res["data"]
    assert d["payment_ref"] == "pi_test_1" and d["amount_minor"] == 4200 and d["payment_mode"] == "test"
    assert d["simulated_merchant"] is True and d["eta"] == "2026-10-16T14:00-04:00"
    assert store.get_record("hh_demo", "order", d["order_id"])["status"] == "paid"
    assert adapters.payments.charges[0]["amount_minor"] == 4200


def test_checkout_rejects_policy_field_mismatches(run, adapters):
    assert err(run("Supplies___checkout", **checkout_args(amount_minor=100))) == "INVALID_INPUT"       # amount
    assert err(run("Supplies___checkout", **checkout_args(category="household"))) == "INVALID_INPUT"   # category
    assert err(run("Supplies___checkout", **checkout_args(merchant="BudgetBasket"))) == "INVALID_INPUT"
    assert err(run("Supplies___checkout", **checkout_args(items=[{"sku": "nope", "qty": 1}]))) == "INVALID_INPUT"
    assert err(run("Supplies___checkout", **checkout_args(deliver_by="2026-10-14"))) == "INVALID_INPUT"  # too late
    assert adapters.payments.charges == []


def test_checkout_quantities_total(run):
    res = run("Supplies___checkout", **checkout_args(items=[{"sku": "drk-party-7", "qty": 2}], amount_minor=8400))
    assert res["ok"]
    assert err(run("Supplies___checkout", **checkout_args(items=[{"sku": "drk-party-7", "qty": 2}], amount_minor=4200))) == "INVALID_INPUT"


def test_refund_is_full_total_once(run, store, adapters):
    order = run("Supplies___checkout", **checkout_args())["data"]["order_id"]
    res = run("Supplies___refund", order_id=order)
    assert res["ok"] and res["data"]["amount_minor"] == 4200 and res["data"]["refund_ref"] == "re_test_1"
    assert store.get_record("hh_demo", "order", order)["status"] == "refunded"
    assert err(run("Supplies___refund", order_id=order)) == "INVALID_INPUT"
    assert err(run("Supplies___refund", order_id="ord_missing")) == "NOT_FOUND"


# ── services ───────────────────────────────────────────────────────────
def test_search_providers_resolves_slots_in_household_tz(run):
    res = run("Services___search_providers", service_type="cleaning", date="2026-10-16")
    provs = res["data"]["providers"]
    assert [p["name"] for p in provs] == ["BrightHome", "Sparkle Cleaners", "TidyUp Co"]
    slots = {p["provider_id"]: p["slot_start"] for p in provs}
    assert slots["prv_sparkle"] == "2026-10-15T15:00-04:00"
    assert slots["prv_brighthome"] == "2026-10-16T10:00-04:00"
    assert slots["prv_tidyup"] == "2026-10-15T09:00-04:00"
    assert all(p["simulated"] and p["currency"] == "USD" for p in provs)


def test_search_providers_excludes_slots_after_date_and_filters_window(run):
    assert run("Services___search_providers", service_type="cleaning", date="2026-10-14")["data"]["providers"] == []
    am = run("Services___search_providers", service_type="cleaning", date="2026-10-16", window="morning")["data"]["providers"]
    assert {p["name"] for p in am} == {"BrightHome", "TidyUp Co"}


def test_book_and_cancel_service(run, store):
    res = run("Services___book_service", provider_id="prv_brighthome", service_type="cleaning",
              slot_start="2026-10-16T10:00:00-04:00", amount_minor=8500, currency="USD")
    assert res["ok"] and res["data"]["simulated"] is True and res["data"]["confirmation_code"].startswith("BK-")
    bid = res["data"]["booking_id"]
    assert store.get_record("hh_demo", "booking", bid)["status"] == "booked"
    assert run("Services___cancel_booking", booking_id=bid)["data"] == {"cancelled": True}
    assert store.get_record("hh_demo", "booking", bid)["status"] == "cancelled"
    assert err(run("Services___cancel_booking", booking_id="bkg_none")) == "NOT_FOUND"


def test_book_service_revalidates_policy_fields(run):
    base = {"provider_id": "prv_brighthome", "service_type": "cleaning", "slot_start": "2026-10-16T10:00:00-04:00",
            "amount_minor": 8500, "currency": "USD"}
    for bad in ({"amount_minor": 100}, {"service_type": "ride"}, {"provider_id": "prv_x"},
                {"slot_start": "2026-10-16T11:00:00-04:00"}):
        assert err(run("Services___book_service", **{**base, **bad})) == "INVALID_INPUT"


# ── weather ────────────────────────────────────────────────────────────
def test_weather_deterministic_fallback_shape(run):
    res = run("Context___get_weather", date="2026-10-16")
    assert res["ok"] and set(res["data"]) == {"summary", "high_c", "low_c", "precip_prob"}
    assert res == run("Context___get_weather", date="2026-10-16")
