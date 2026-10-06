import os
from datetime import UTC

import pytest
from moto import mock_aws


@pytest.fixture
def store():
    os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
    os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        from butler_actions.store import Store
        yield Store.create_table("butler-test")


NOW_ISO = "2026-10-06T12:00:00+00:00"


@pytest.fixture
def pinned_now():
    from datetime import datetime

    from butler_actions import clock

    clock.set_now(datetime(2026, 10, 6, 12, 0, tzinfo=UTC))
    yield clock.now()
    clock.set_now(None)


@pytest.fixture
def seeded(store, pinned_now):
    """Store with the five default rules active, in household hh_t."""
    from butler_rules import Identities, LocalPolicyService, default_rules

    ids = Identities.local()
    svc = LocalPolicyService(store, ids=ids)
    for r in default_rules("hh_t", ids, NOW_ISO):
        svc.create(r)
    return store
