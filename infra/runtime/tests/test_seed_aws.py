import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import seed_aws
from butler_actions.store import Store
from butler_local.seed import seed
from butler_rules import DEFAULT_RULE_IDS, Identities
from butler_rules.policy_service import policy_name
from moto import mock_aws

IDS = Identities("agent-client-id", "executor-client-id", "arn:aws:bedrock-agentcore:us-east-1:111111111111:gateway/g-1")


class FakeControl:
    def __init__(self, names):
        self.names = names

    def list_policies(self, policyEngineId, nextToken=None):
        assert policyEngineId == "eng-1"
        if nextToken is None:  # two pages, to exercise pagination
            return {"policies": [{"name": n, "policyId": f"pol-{n}"} for n in self.names[:2]], "nextToken": "p2"}
        return {"policies": [{"name": n, "policyId": f"pol-{n}"} for n in self.names[2:]]}


@pytest.fixture
def store():
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
    with mock_aws():
        yield Store.create_table("butler-test")


def test_default_rules_are_linked_to_the_deployed_policies(store):
    summary = seed(store, ids=IDS)
    deployed = [policy_name(r) for r in DEFAULT_RULE_IDS] + ["base_permit"]
    linked = seed_aws.link_default_policies(store, summary["household_id"], FakeControl(deployed), "eng-1")
    assert linked == list(DEFAULT_RULE_IDS)
    for rid in DEFAULT_RULE_IDS:
        rule = store.get_rule(summary["household_id"], rid)
        assert rule.policy_id == f"pol-{policy_name(rid)}" and rule.active and rule.policy_status == "active"
        assert "agent-client-id" in rule.cedar_statement or rid == "rule_default_calendar"  # compiled with the REAL client id


def test_missing_policy_is_an_error(store):
    summary = seed(store, ids=IDS)
    with pytest.raises(SystemExit, match="without a deployed policy"):
        seed_aws.link_default_policies(store, summary["household_id"], FakeControl(["base_permit"]), "eng-1")


def test_ssm_values_strips_the_prefix_and_paginates():
    class Ssm:
        def get_parameters_by_path(self, Path, Recursive, NextToken=None):
            assert Path == "/butler/dev/" and Recursive
            if NextToken is None:
                return {"Parameters": [{"Name": "/butler/dev/table-name", "Value": "butler-dev"}], "NextToken": "n"}
            return {"Parameters": [{"Name": "/butler/dev/cognito/agent-client-id", "Value": "abc"}]}

    assert seed_aws.ssm_values(Ssm(), "dev") == {"table-name": "butler-dev", "cognito/agent-client-id": "abc"}
