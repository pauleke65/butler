import pytest
from butler_rules import Identities, default_rules

NOW = "2026-10-06T12:00:00+00:00"


@pytest.fixture
def ids() -> Identities:
    return Identities.local()


@pytest.fixture
def active_defaults(ids):
    """The five default rules, marked active (as the seed does)."""
    return [r.model_copy(update={"active": True, "policy_status": "active"}) for r in default_rules("hh_t", ids, NOW)]


@pytest.fixture
def store():
    import os

    from moto import mock_aws

    os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        from butler_actions.store import Store

        yield Store.create_table("butler-test")
