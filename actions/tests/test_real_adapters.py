"""Real adapters, exercised with botocore Stubber and httpx.MockTransport only (no network)."""
import json
from urllib.parse import parse_qs

import boto3
import httpx
import pytest
from botocore.stub import Stubber
from butler_action_handlers.adapters import default_adapters
from butler_action_handlers.errors import UpstreamUnavailable
from butler_action_handlers.real_adapters import (
    GoogleCalendarAdapter,
    OpenMeteoWeatherAdapter,
    PaystackTestAdapter,
    SesEmailAdapter,
    StripeTestAdapter,
    load_google_credentials,
)

CREDS = {"client_id": "cid", "client_secret": "sec", "refresh_token": "rt"}


def ses_client():
    return boto3.client("ses", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="y")


def test_ses_send_and_rejection():
    client = ses_client()
    with Stubber(client) as stub:
        stub.add_response("send_email", {"MessageId": "mid-1"}, {
            "Source": "butler@example.com", "Destination": {"ToAddresses": ["a@b.co"]},
            "Message": {"Subject": {"Data": "Hi", "Charset": "UTF-8"}, "Body": {
                "Text": {"Data": "Hello", "Charset": "UTF-8"}, "Html": {"Data": "<p>Hello</p>", "Charset": "UTF-8"}}}})
        stub.add_client_error("send_email", "MessageRejected", "Email address is not verified.")
        ses = SesEmailAdapter(client, sender="butler@example.com")
        assert ses.send("a@b.co", "Hi", "Hello", "<p>Hello</p>") == "mid-1"
        with pytest.raises(UpstreamUnavailable, match="isn't verified"):
            ses.send("c@d.co", "Hi", "Hello")


def google_transport(calls: list[httpx.Request]):
    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        path = req.url.path
        if req.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        assert req.headers["authorization"] == "Bearer tok"
        if req.method == "POST" and path.endswith("/events"):
            return httpx.Response(200, json={"id": "g1", "htmlLink": "https://cal/g1"})
        if req.method == "GET" and path.endswith("/events/butlerev"):
            return httpx.Response(200, json={"id": "butlerev", "summary": "Dinner", "start": {"dateTime": "s"}, "end": {"dateTime": "e"},
                                             "extendedProperties": {"private": {"butler_owner": "butler"}}})
        if req.method == "GET" and path.endswith("/events/humanev"):
            return httpx.Response(200, json={"id": "humanev", "summary": "Dentist", "start": {"dateTime": "s"}, "end": {"dateTime": "e"}})
        if req.method == "GET" and path.endswith("/events/missing"):
            return httpx.Response(404, json={})
        if req.method == "PATCH":
            return httpx.Response(200, json={"id": "g1", "summary": "New", "start": {"dateTime": "s"}, "end": {"dateTime": "e"}})
        if req.method == "DELETE":
            return httpx.Response(204)
        if req.method == "GET" and path.endswith("/events"):
            return httpx.Response(200, json={"items": [{"id": "x", "summary": "T", "start": {"date": "2026-10-16"}, "end": {"date": "2026-10-17"}}]})
        return httpx.Response(500)

    return httpx.MockTransport(handler)


def test_google_calendar_round_trip_sets_butler_owner_and_sends_updates():
    calls: list[httpx.Request] = []
    cal = GoogleCalendarAdapter(CREDS, httpx.Client(transport=google_transport(calls)), calendar_id="primary")
    created = cal.create_event(title="Dinner", start="2026-10-16T19:00:00-04:00", end="2026-10-16T22:00:00-04:00",
                               attendee_emails=["a@b.co"], location=None, description=None, owner="butler")
    assert created == {"event_id": "g1", "html_link": "https://cal/g1"}
    create_call = next(c for c in calls if c.method == "POST" and c.url.path.endswith("/events"))
    assert create_call.url.params["sendUpdates"] == "all"
    body = json.loads(create_call.content)
    assert body["extendedProperties"]["private"]["butler_owner"] == "butler"
    assert body["attendees"] == [{"email": "a@b.co"}]
    assert cal.get_event("butlerev")["butler_owner"] == "butler"
    assert cal.get_event("humanev")["butler_owner"] == "human"  # missing property = human
    assert cal.get_event("missing") is None
    assert cal.update_event("g1", {"title": "New"})["title"] == "New"
    cal.delete_event("g1")
    assert cal.list_events("2026-10-16T00:00:00-04:00", "2026-10-17T00:00:00-04:00")[0]["start"] == "2026-10-16"
    assert sum(1 for c in calls if c.url.host == "oauth2.googleapis.com") == 1  # token cached


def test_google_calendar_errors_are_upstream_unavailable():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={}) if req.url.host == "oauth2.googleapis.com" else httpx.Response(200)

    cal = GoogleCalendarAdapter(CREDS, httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(UpstreamUnavailable):
        cal.list_events("2026-10-16", "2026-10-17")


def test_google_credentials_from_env_and_secrets_manager():
    env = {"GOOGLE_CLIENT_ID": "a", "GOOGLE_CLIENT_SECRET": "b", "GOOGLE_REFRESH_TOKEN": "c"}
    assert load_google_credentials(env) == {"client_id": "a", "client_secret": "b", "refresh_token": "c"}
    sm = boto3.client("secretsmanager", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="y")
    with Stubber(sm) as stub:
        stub.add_response("get_secret_value", {"SecretString": json.dumps(CREDS)}, {"SecretId": "sid"})
        assert load_google_credentials({"GOOGLE_OAUTH_SECRET_ID": "sid"}, sm) == CREDS
    with pytest.raises(UpstreamUnavailable):
        load_google_credentials({})


def test_stripe_charge_and_refund_use_test_mode_and_idempotency_keys():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path == "/v1/payment_intents":
            return httpx.Response(200, json={"id": "pi_123", "status": "succeeded"})
        return httpx.Response(200, json={"id": "re_123"})

    stripe = StripeTestAdapter("sk_test_abc", httpx.Client(transport=httpx.MockTransport(handler)))
    assert stripe.charge(4200, "USD", "Order", "plan:need:checkout:1", {"correlation_id": "c"}) == "pi_123"
    form = parse_qs(seen[0].content.decode())
    assert form["amount"] == ["4200"] and form["currency"] == ["usd"] and form["payment_method"] == ["pm_card_visa"]
    assert seen[0].headers["idempotency-key"] == "plan:need:checkout:1"
    assert stripe.refund("pi_123", 4200, "k") == "re_123"
    assert parse_qs(seen[1].content.decode())["payment_intent"] == ["pi_123"]


def test_stripe_failures_and_live_key_refused():
    with pytest.raises(ValueError, match="test mode"):
        StripeTestAdapter("sk_live_abc")
    declined = httpx.MockTransport(lambda r: httpx.Response(402, json={"error": {"message": "Your card was declined."}}))
    with pytest.raises(UpstreamUnavailable, match="declined"):
        StripeTestAdapter("sk_test_abc", httpx.Client(transport=declined)).charge(100, "USD", "d", "k", {})
    pending = httpx.MockTransport(lambda r: httpx.Response(200, json={"id": "pi_1", "status": "requires_action"}))
    with pytest.raises(UpstreamUnavailable, match="did not complete"):
        StripeTestAdapter("sk_test_abc", httpx.Client(transport=pending)).charge(100, "USD", "d", "k", {})


def test_paystack_test_transaction_and_refund():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path == "/transaction/initialize":
            return httpx.Response(200, json={"status": True, "data": {"reference": json.loads(req.content)["reference"]}})
        return httpx.Response(200, json={"status": True, "data": {"id": 77}})

    ps = PaystackTestAdapter("sk_test_abc", httpx.Client(transport=httpx.MockTransport(handler)), email="t@example.com")
    ref = ps.charge(4200, "USD", "Order", "plan:need:checkout:1", {"correlation_id": "c"})
    assert ref == "butler-plan-need-checkout-1"
    assert json.loads(seen[0].content)["amount"] == 4200
    assert ps.refund(ref, 4200, "k") == "77"
    bad = httpx.MockTransport(lambda r: httpx.Response(400, json={"status": False, "message": "Invalid key"}))
    with pytest.raises(UpstreamUnavailable, match="Invalid key"):
        PaystackTestAdapter("sk_test_abc", httpx.Client(transport=bad)).charge(1, "USD", "d", "k", {})


def test_open_meteo_parses_and_falls_back_offline():
    ok = httpx.MockTransport(lambda r: httpx.Response(200, json={"daily": {
        "temperature_2m_max": [18.2], "temperature_2m_min": [9.1], "precipitation_probability_max": [70]}}))
    f = OpenMeteoWeatherAdapter(httpx.Client(transport=ok)).forecast("2026-10-16", 40.7, -74.0)
    assert f["high_c"] == 18.2 and f["precip_prob"] == 0.7 and f["source"] == "open-meteo" and "Showers" in f["summary"]

    def boom(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("offline")

    fb = OpenMeteoWeatherAdapter(httpx.Client(transport=httpx.MockTransport(boom))).forecast("2026-10-16", 40.7, -74.0)
    assert fb["source"] == "fallback" and fb == OpenMeteoWeatherAdapter(httpx.Client(transport=httpx.MockTransport(boom))).forecast("2026-10-16", 1, 2)


def test_default_adapters_modes(monkeypatch):
    fake = default_adapters("fake")
    assert fake.payments.charge(100, "USD", "d", "k", {}) == "pi_test_1"
    monkeypatch.setenv("ADAPTERS", "fake")
    assert type(default_adapters().email).__name__ == "FakeEmailAdapter"
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_zzz")
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "x")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "y")
    real = default_adapters("real")
    assert type(real.email).__name__ == "SesEmailAdapter" and type(real.payments).__name__ == "StripeTestAdapter"
