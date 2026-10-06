"""Fixtures written for the TypeScript side must validate with the generated Pydantic models."""
import json
from pathlib import Path

import pytest
from butler_contracts import models as m

FIX = Path(__file__).resolve().parents[2] / "fixtures"
MODEL_BY_FILE = {"plan": m.Plan, "receipt": m.Receipt, "rule": m.Rule, "decision": m.Decision}


def _items(data):
    return data if isinstance(data, list) else [data]


@pytest.mark.parametrize("path", sorted(FIX.glob("*.json")))
def test_fixture_validates(path):
    data = json.loads(path.read_text())
    model = next((cls for key, cls in MODEL_BY_FILE.items() if key in path.stem.lower()), None)
    if model is None:
        pytest.skip(f"no model mapping for {path.name}")
    for item in _items(data):
        model.model_validate(item)
