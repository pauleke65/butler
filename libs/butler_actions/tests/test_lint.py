import pytest
from butler_actions.lint import lint_spoken


@pytest.mark.parametrize("text", [
    "I bought drinks for 42 dollars because six guests are coming. Your 50 dollar limit allowed it.",
    "I held it because you asked me to check before buying drinks.",
    "Invites went to Tolu, Sam and Ada. Should I add Maya too?",
    "Done.",
    "I sent the invite for 7 PM Friday.",
])
def test_clean(text):
    assert lint_spoken(text) == []


@pytest.mark.parametrize(("text", "needle"), [
    ("", "empty"),
    ("One. Two. Three.", "sentences"),
    (" ".join(["word"] * 36) + ".", "words"),
    ("Is it ok? Really?", "question"),
    ("Is it ok? Yes it is.", "question"),
    ("I **bought** drinks.", "markdown"),
    ("- bought drinks", "markdown"),
    ("a | b", "markdown"),
    ("See [this](http://x.y) now.", "markdown"),
    ("Bought drinks 🍺.", "emoji"),
    ("Visit https://example.com now.", "URL"),
    ("Look at example.com.", "URL"),
    ("Order ord_01J9ZZZZZZZZZZZZZZZZZZZZZZ is done.", "ID"),
    ("Receipt act_abc123 is done.", "ID"),
    ('Result {"ok": true}.', "JSON"),
    ("It cost $42.50.", "money"),
    ("It cost 42.50 dollars.", "money"),
    ("On 2026-10-16 at dinner.", "ISO"),
])
def test_violations(text, needle):
    v = lint_spoken(text)
    assert v and any(needle in x for x in v), v
