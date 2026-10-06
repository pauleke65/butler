"""Real adapters: SES (boto3), Google Calendar REST, Stripe / Paystack test mode, Open-Meteo.

Every network client is injectable so tests use ``httpx.MockTransport`` / botocore ``Stubber``.
"""
from __future__ import annotations

import json
import logging
import os
import time as _time
from collections.abc import Callable
from typing import Any

import boto3
import httpx
from botocore.exceptions import BotoCoreError, ClientError

from .adapters import Adapters, fallback_forecast
from .errors import UpstreamUnavailable

log = logging.getLogger("butler.actions")
HTTP_TIMEOUT = 10.0


# ── SES ────────────────────────────────────────────────────────────────
class SesEmailAdapter:
    def __init__(self, client: Any | None = None, sender: str | None = None):
        self.client = client or boto3.client("ses", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        self.sender = sender or os.environ.get("SES_FROM", "butler@example.com")

    def send(self, to: str, subject: str, body_text: str, body_html: str | None = None) -> str:
        body: dict[str, Any] = {"Text": {"Data": body_text, "Charset": "UTF-8"}}
        if body_html:
            body["Html"] = {"Data": body_html, "Charset": "UTF-8"}
        try:
            res = self.client.send_email(
                Source=self.sender, Destination={"ToAddresses": [to]},
                Message={"Subject": {"Data": subject, "Charset": "UTF-8"}, "Body": body},
            )
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code", "")
            if code in ("MessageRejected", "MailFromDomainNotVerified"):
                raise UpstreamUnavailable("That address isn't verified for sending in this environment.") from e
            raise UpstreamUnavailable(f"Email service error: {code or 'unknown'}") from e
        except BotoCoreError as e:
            raise UpstreamUnavailable("Email service is not reachable.") from e
        return str(res["MessageId"])


# ── Google Calendar ────────────────────────────────────────────────────
def load_google_credentials(env: dict[str, str] | None = None, secrets_client: Any | None = None) -> dict[str, str]:
    """client_id / client_secret / refresh_token from env, or a Secrets Manager JSON secret."""
    env = dict(os.environ) if env is None else env
    if env.get("GOOGLE_REFRESH_TOKEN"):
        return {"client_id": env["GOOGLE_CLIENT_ID"], "client_secret": env["GOOGLE_CLIENT_SECRET"],
                "refresh_token": env["GOOGLE_REFRESH_TOKEN"]}
    secret_id = env.get("GOOGLE_OAUTH_SECRET_ID")
    if not secret_id:
        raise UpstreamUnavailable("Google Calendar credentials are not configured.")
    client = secrets_client or boto3.client("secretsmanager", region_name=env.get("AWS_REGION", "us-east-1"))
    raw = json.loads(client.get_secret_value(SecretId=secret_id)["SecretString"])
    return {k: raw[k] for k in ("client_id", "client_secret", "refresh_token")}


class GoogleCalendarAdapter:
    API = "https://www.googleapis.com/calendar/v3"
    TOKEN_URL = "https://oauth2.googleapis.com/token"

    def __init__(self, credentials: dict[str, str] | Callable[[], dict[str, str]], client: httpx.Client | None = None,
                 calendar_id: str | None = None):
        self._credentials = credentials
        self.http = client or httpx.Client(timeout=HTTP_TIMEOUT)
        self.calendar_id = calendar_id or os.environ.get("GOOGLE_CALENDAR_ID", "primary")
        self._token: tuple[str, float] | None = None

    def _creds(self) -> dict[str, str]:
        return self._credentials() if callable(self._credentials) else self._credentials

    def _access_token(self) -> str:
        if self._token and self._token[1] > _time.time() + 30:
            return self._token[0]
        c = self._creds()
        res = self.http.post(self.TOKEN_URL, data={"client_id": c["client_id"], "client_secret": c["client_secret"],
                                                   "refresh_token": c["refresh_token"], "grant_type": "refresh_token"})
        if res.status_code != 200:
            raise UpstreamUnavailable("Couldn't sign in to Google Calendar.")
        body = res.json()
        self._token = (body["access_token"], _time.time() + int(body.get("expires_in", 3600)))
        return self._token[0]

    def _request(self, method: str, path: str, *, ok_404: bool = False, **kwargs: Any) -> httpx.Response:
        try:
            res = self.http.request(method, f"{self.API}/calendars/{self.calendar_id}{path}",
                                    headers={"Authorization": f"Bearer {self._access_token()}"}, **kwargs)
        except httpx.HTTPError as e:
            raise UpstreamUnavailable("Google Calendar isn't responding.") from e
        if res.status_code == 404 and ok_404:
            return res
        if res.status_code >= 400:
            raise UpstreamUnavailable(f"Google Calendar error {res.status_code}.")
        return res

    @staticmethod
    def _shape(item: dict[str, Any]) -> dict[str, Any]:
        owner = (item.get("extendedProperties") or {}).get("private", {}).get("butler_owner")
        return {"event_id": item["id"], "title": item.get("summary", ""),
                "start": item.get("start", {}).get("dateTime") or item.get("start", {}).get("date", ""),
                "end": item.get("end", {}).get("dateTime") or item.get("end", {}).get("date", ""),
                "butler_owner": "butler" if owner == "butler" else "human"}

    def create_event(self, *, title: str, start: str, end: str, attendee_emails: list[str],
                     location: str | None, description: str | None, owner: str) -> dict[str, Any]:
        body: dict[str, Any] = {"summary": title, "start": {"dateTime": start}, "end": {"dateTime": end},
                                "extendedProperties": {"private": {"butler_owner": owner}}}
        if attendee_emails:
            body["attendees"] = [{"email": e} for e in attendee_emails]
        if location:
            body["location"] = location
        if description:
            body["description"] = description
        res = self._request("POST", "/events", params={"sendUpdates": "all"}, json=body).json()
        return {"event_id": res["id"], "html_link": res.get("htmlLink", "")}

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        res = self._request("GET", f"/events/{event_id}", ok_404=True)
        return None if res.status_code == 404 else self._shape(res.json())

    def update_event(self, event_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if fields.get("title"):
            body["summary"] = fields["title"]
        if fields.get("start"):
            body["start"] = {"dateTime": fields["start"]}
        if fields.get("end"):
            body["end"] = {"dateTime": fields["end"]}
        return self._shape(self._request("PATCH", f"/events/{event_id}", params={"sendUpdates": "all"}, json=body).json())

    def delete_event(self, event_id: str) -> None:
        self._request("DELETE", f"/events/{event_id}", params={"sendUpdates": "all"})

    def list_events(self, time_min: str, time_max: str) -> list[dict[str, Any]]:
        res = self._request("GET", "/events", params={"timeMin": time_min, "timeMax": time_max,
                                                      "singleEvents": "true", "orderBy": "startTime"}).json()
        return [self._shape(i) for i in res.get("items", [])]


# ── payments (test mode only) ──────────────────────────────────────────
def _require_test_key(key: str) -> str:
    if not key.startswith(("sk_test_", "rk_test_")):
        raise ValueError("Payments run in test mode only: expected a test secret key.")
    return key


class StripeTestAdapter:
    BASE = "https://api.stripe.com/v1"

    def __init__(self, secret_key: str, client: httpx.Client | None = None):
        self.key = _require_test_key(secret_key)
        self.http = client or httpx.Client(timeout=HTTP_TIMEOUT)

    def _post(self, path: str, data: dict[str, str], idempotency_key: str) -> dict[str, Any]:
        try:
            res = self.http.post(f"{self.BASE}{path}", data=data, headers={
                "Authorization": f"Bearer {self.key}", "Idempotency-Key": idempotency_key})
        except httpx.HTTPError as e:
            raise UpstreamUnavailable("The payment provider isn't responding.") from e
        if res.status_code >= 400:
            msg = res.json().get("error", {}).get("message", "payment failed") if res.content else "payment failed"
            raise UpstreamUnavailable(f"Payment provider rejected the request: {msg}")
        return res.json()

    def charge(self, amount_minor: int, currency: str, description: str, idempotency_key: str,
               metadata: dict[str, str]) -> str:
        data = {"amount": str(amount_minor), "currency": currency.lower(), "payment_method": "pm_card_visa",
                "confirm": "true", "description": description,
                "automatic_payment_methods[enabled]": "true", "automatic_payment_methods[allow_redirects]": "never"}
        data.update({f"metadata[{k}]": v for k, v in metadata.items()})
        body = self._post("/payment_intents", data, idempotency_key)
        if body.get("status") != "succeeded":
            raise UpstreamUnavailable(f"Test payment did not complete ({body.get('status')}).")
        return str(body["id"])

    def refund(self, payment_ref: str, amount_minor: int, idempotency_key: str) -> str:
        body = self._post("/refunds", {"payment_intent": payment_ref, "amount": str(amount_minor)},
                          f"refund-{idempotency_key}")
        return str(body["id"])


class PaystackTestAdapter:
    """Paystack test mode. ``/transaction/initialize`` creates a test transaction (visible in the test
    dashboard); a full card charge needs the hosted checkout, so the transaction stays pending."""

    BASE = "https://api.paystack.co"

    def __init__(self, secret_key: str, client: httpx.Client | None = None, email: str | None = None):
        self.key = _require_test_key(secret_key)
        self.http = client or httpx.Client(timeout=HTTP_TIMEOUT)
        self.email = email or os.environ.get("PAYSTACK_CUSTOMER_EMAIL", "butler.demo@example.com")

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            res = self.http.post(f"{self.BASE}{path}", json=body, headers={"Authorization": f"Bearer {self.key}"})
        except httpx.HTTPError as e:
            raise UpstreamUnavailable("The payment provider isn't responding.") from e
        data = res.json() if res.content else {}
        if res.status_code >= 400 or not data.get("status"):
            raise UpstreamUnavailable(f"Payment provider rejected the request: {data.get('message', res.status_code)}")
        return data["data"]

    def charge(self, amount_minor: int, currency: str, description: str, idempotency_key: str,
               metadata: dict[str, str]) -> str:
        data = self._post("/transaction/initialize", {
            "email": self.email, "amount": amount_minor, "currency": currency.upper(),
            "reference": f"butler-{idempotency_key}"[:100].replace(":", "-"), "metadata": {**metadata, "description": description}})
        return str(data["reference"])

    def refund(self, payment_ref: str, amount_minor: int, idempotency_key: str) -> str:
        data = self._post("/refund", {"transaction": payment_ref, "amount": amount_minor})
        return str(data.get("id", f"refund-{payment_ref}"))


# ── weather ────────────────────────────────────────────────────────────
class OpenMeteoWeatherAdapter:
    URL = "https://api.open-meteo.com/v1/forecast"

    def __init__(self, client: httpx.Client | None = None, timeout: float = 3.0):
        self.http = client or httpx.Client(timeout=timeout)

    def forecast(self, date: str, lat: float, lon: float) -> dict[str, Any]:
        day = date[:10]
        try:
            res = self.http.get(self.URL, params={
                "latitude": lat, "longitude": lon, "start_date": day, "end_date": day, "timezone": "auto",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max"})
            res.raise_for_status()
            d = res.json()["daily"]
            high, low = float(d["temperature_2m_max"][0]), float(d["temperature_2m_min"][0])
            precip = float(d["precipitation_probability_max"][0] or 0) / 100
        except (httpx.HTTPError, KeyError, IndexError, ValueError, TypeError) as e:
            log.warning("open-meteo unavailable, using fallback: %s", e)
            return fallback_forecast(day)
        summary = ("Showers likely" if precip >= 0.6 else "A chance of showers" if precip >= 0.3 else "Mostly dry")
        return {"summary": f"{summary}, high {round(high)} degrees", "high_c": high, "low_c": low,
                "precip_prob": precip, "source": "open-meteo"}


def payment_adapter_from_env(env: dict[str, str] | None = None) -> StripeTestAdapter | PaystackTestAdapter:
    env = dict(os.environ) if env is None else env
    if env.get("PAYMENT_PROVIDER", "stripe") == "paystack":
        return PaystackTestAdapter(env["PAYSTACK_SECRET_KEY"])
    return StripeTestAdapter(env["STRIPE_SECRET_KEY"])


def real_adapters() -> Adapters:
    return Adapters(
        email=SesEmailAdapter(),
        calendar=GoogleCalendarAdapter(load_google_credentials),
        payments=payment_adapter_from_env(),
        weather=OpenMeteoWeatherAdapter(),
    )
