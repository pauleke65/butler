"""The Gateway Lambda entry: tool-name resolution, household from env, error envelopes, small import graph."""
import subprocess
import sys
from types import SimpleNamespace

import pytest
from action_fixtures import NOW  # noqa: F401  (also puts tests/ on the path)
from butler_action_handlers import lambda_handler as lh


def ctx(name: str | None = "Supplies___search_products") -> SimpleNamespace:
    custom = {} if name is None else {lh.TOOL_NAME_KEY: name}
    return SimpleNamespace(client_context=SimpleNamespace(custom=custom))


def event(**args):
    return {"idempotency_key": "k1", "correlation_id": "cor_test", **args}


@pytest.fixture(autouse=True)
def _aws_stage(monkeypatch):
    monkeypatch.setenv("STAGE", "dev")  # not local: household comes from HOUSEHOLD_ID only
    monkeypatch.setenv("HOUSEHOLD_ID", "hh_demo")
    monkeypatch.delenv("ADAPTERS", raising=False)


def test_resolve_tool_forms():
    assert lh.resolve_tool("Supplies___checkout") == "Supplies___checkout"
    assert lh.resolve_tool("my-target___Supplies___checkout") == "Supplies___checkout"  # tolerated prefix
    assert lh.resolve_tool("checkout") == "Supplies___checkout"  # unambiguous bare name
    assert lh.resolve_tool("nope___nothing") is None


def test_raw_tool_name_reads_client_context_custom():
    assert lh.raw_tool_name(ctx("Context___get_weather")) == "Context___get_weather"
    assert lh.raw_tool_name(ctx(None)) is None
    assert lh.raw_tool_name(None) is None
    assert lh.raw_tool_name(SimpleNamespace(client_context=None)) is None


def test_search_products_through_the_handler(store, adapters):
    res = lh.handler(event(query="drinks for 7"), ctx("Supplies___search_products"), store=store, adapters=adapters)
    assert res["ok"] is True
    assert res["data"]["products"]


def test_every_gateway_tool_name_dispatches():
    from butler_action_handlers import TOOLS

    for key in TOOLS:
        assert lh.resolve_tool(key) == key


def test_missing_tool_name_is_invalid_input(store, adapters):
    res = lh.handler(event(query="x"), ctx(None), store=store, adapters=adapters)
    assert res == {"ok": False, "error": {"code": "INVALID_INPUT", "message": f"Missing {lh.TOOL_NAME_KEY} in the Lambda client context."}}


def test_unknown_tool_is_not_found(store, adapters):
    res = lh.handler(event(), ctx("Bogus___tool"), store=store, adapters=adapters)
    assert res["error"]["code"] == "NOT_FOUND"


def test_household_comes_from_env_not_from_input(store, adapters, monkeypatch):
    mail = event(recipient_contact_ids=["c_tolu"], subject="Hi", body_text="Hello", kind="notice")
    ok = lh.handler(mail, ctx("Messages___send_email"), store=store, adapters=adapters)
    assert ok["ok"] is True and adapters.email.sent  # contact lives in hh_demo, the env household
    monkeypatch.setenv("HOUSEHOLD_ID", "hh_other")
    # an input household_id must be ignored outside local: hh_other has no c_tolu
    spoofed = lh.handler({**mail, "idempotency_key": "k2", "household_id": "hh_demo"}, ctx("Messages___send_email"),
                         store=store, adapters=adapters)
    assert spoofed["ok"] is False and spoofed["error"]["code"] == "INVALID_INPUT"


def test_invalid_input_is_an_envelope_not_a_crash(store, adapters):
    res = lh.handler(event(), ctx("Supplies___checkout"), store=store, adapters=adapters)  # missing required fields
    assert res["ok"] is False and res["error"]["code"] == "INVALID_INPUT"


def test_unexpected_exception_becomes_an_envelope(store, adapters, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(lh, "dispatch", boom)
    res = lh.handler(event(query="x"), ctx(), store=store, adapters=adapters)
    assert res["ok"] is False and res["error"]["code"] == "UPSTREAM_UNAVAILABLE"


def test_real_adapters_are_lazy_about_the_payment_key(monkeypatch):
    """ADAPTERS=real must build without a payment key (read-only tools keep working until it is set)."""
    monkeypatch.setenv("ADAPTERS", "real")
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)
    monkeypatch.delenv("PAYMENT_SECRET_ARN", raising=False)
    monkeypatch.setattr(lh, "_adapters", None)
    built = lh.get_adapters()
    assert built is not None and isinstance(built.payments, lh._LazyPayments)
    with pytest.raises(KeyError):
        built.payments.charge(100, "USD", "x", "k", {})  # key missing -> fails only when a charge is attempted


def test_import_graph_stays_small():
    """The actions Lambda ships without butler_rules / cedarpy / moto; importing the entry must not need them."""
    code = ("import sys, butler_action_handlers.lambda_handler;"
            "bad=[m for m in ('cedarpy','butler_rules','moto','pytest','starlette','uvicorn') if m in sys.modules];"
            "print(','.join(bad)); sys.exit(1 if bad else 0)")
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert res.returncode == 0, f"unexpected imports in the Lambda entry: {res.stdout.strip()} {res.stderr[-300:]}"
