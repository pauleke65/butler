import json
import os

import pytest
from action_fixtures import NOW, SEED
from moto import mock_aws

os.environ["BUTLER_SEED_DIR"] = str(SEED)


@pytest.fixture
def store():
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")  # credentials come from mock_aws, never exported
    with mock_aws():
        from butler_actions.store import Store
        from butler_contracts.models import Contact, Household

        s = Store.create_table("butler-test")
        data = json.loads((SEED / "household.json").read_text())
        s.put_household(Household(**data["household"]))
        for c in json.loads((SEED / "contacts.json").read_text()):
            s.put_contact("hh_demo", Contact(**c))
        yield s


@pytest.fixture
def adapters():
    from butler_action_handlers import fake_adapters

    return fake_adapters()


@pytest.fixture
def run(store, adapters):
    """run(tool, **args) -> dispatch result, with common fields filled in."""
    from butler_action_handlers import dispatch

    counter = {"n": 0}

    def _run(tool: str, now=NOW, **args):
        counter["n"] += 1
        event = {"idempotency_key": f"k{counter['n']}", "correlation_id": "cor_test", **args}
        return dispatch(tool, event, store=store, now=now, adapters=adapters)

    return _run
