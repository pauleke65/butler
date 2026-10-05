import os
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
