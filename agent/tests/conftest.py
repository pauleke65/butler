import os
import pathlib

import pytest
from moto import mock_aws

# Never export dummy AWS credentials here: the opt-in bedrock test must use the developer's real ones.
# (``mock_aws`` installs fake credentials only while it is active.)
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["BUTLER_SEED_DIR"] = str(pathlib.Path(__file__).resolve().parents[2] / "seed")


def pytest_configure(config):
    config.addinivalue_line("markers", "bedrock: calls real Bedrock; skipped unless RUN_BEDROCK_TESTS=1")


def pytest_collection_modifyitems(config, items):
    if os.environ.get("RUN_BEDROCK_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="set RUN_BEDROCK_TESTS=1 to call Bedrock")
    for item in items:
        if "bedrock" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def store():
    with mock_aws():
        from agent_support import seed_world
        from butler_actions.store import Store

        s = Store.create_table("butler-agent-test")
        seed_world(s)
        yield s


@pytest.fixture
def world(store):
    from agent_support import World
    from butler_actions import clock

    w = World(store)
    yield w
    clock.set_now(None)
