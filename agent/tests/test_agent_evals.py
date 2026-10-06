"""The eval suite (A-13) must pass its offline gate in CI."""
import importlib.util
import pathlib

EVALS = pathlib.Path(__file__).resolve().parents[2] / "evals"


def load_runner():
    spec = importlib.util.spec_from_file_location("butler_evals_run", EVALS / "run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_rule_utterances_supported_subset_is_100_percent():
    rows = load_runner().run_rules("offline")
    assert len(rows) == 20
    pattern = [r for r in rows if r["group"] == "rules/pattern"]
    assert pattern and all(r["ok"] for r in pattern), [r for r in pattern if not r["ok"]]


def test_situations_pass_offline():
    runner = load_runner()
    rows = runner.run_situations("offline")
    assert len(rows) == 15 and {r["group"] for r in rows} == {"situations/hosting", "situations/away", "situations/running_low"}
    assert sum(r["ok"] for r in rows) / len(rows) >= 0.9, [r for r in rows if not r["ok"]]
