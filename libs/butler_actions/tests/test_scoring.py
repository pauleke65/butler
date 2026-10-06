from actions_helpers import NOW, add_purchase
from butler_actions.scoring import might_disagree

CO = "Supplies___checkout"


def score(store, args, reasoning=None, tool=CO):
    return might_disagree(store, "hh_t", tool, args, reasoning, NOW)


def _history(store):
    for d, amt in ((41, 2800), (34, 3000), (25, 3300)):
        add_purchase(store, days_ago=d, category="drinks", merchant="FreshCart", amount_minor=amt)


def test_first_of_kind_only(seeded):
    out = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 1000})
    assert out == {"score": 0.3, "top_reason": "It's the first time I bought drinks"}


def test_first_time_booking_a_cleaner_reason(seeded):
    out = score(seeded, {"service_type": "cleaning", "provider_id": "p1", "amount_minor": 2000}, tool="Services___book_service")
    assert out["score"] == 0.3 and out["top_reason"] == "It's the first time I booked a cleaner"


def test_seed_story_4200_drinks_is_near_cap_and_above_usual(seeded):
    _history(seeded)
    out = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 4200})
    assert out["score"] == 0.45  # near_cap 0.25 (>= 80% of 5000) + above_usual 0.20 (median 3000 * 1.2 = 3600)
    assert out["top_reason"] == "It's close to your spending limit"


def test_normal_repeat_scores_zero(seeded):
    _history(seeded)
    assert score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 3100}) == {"score": 0.0, "top_reason": None}


def test_exact_thresholds(seeded):
    _history(seeded)
    near = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 4000})
    assert near["score"] == 0.45  # 4000 == 80% of cap counts; also >= 120% of median 3000? 3600 <= 4000 yes
    below = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 3999})
    assert below["score"] == 0.2  # above usual only


def test_differs_from_last_two_merchants(seeded):
    _history(seeded)
    out = score(seeded, {"category": "drinks", "merchant": "BigBox", "amount_minor": 3000})
    assert out == {"score": 0.15, "top_reason": "I used a different seller than last time"}
    add_purchase(seeded, days_ago=2, category="drinks", merchant="BigBox", amount_minor=3000)
    assert score(seeded, {"category": "drinks", "merchant": "BigBox", "amount_minor": 3000})["score"] == 0.0


def test_low_confidence_and_combination(seeded):
    _history(seeded)
    out = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 3000}, {"confidence": 0.59})
    assert out == {"score": 0.1, "top_reason": "I wasn't sure about this one"}
    out = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 3000}, {"confidence": 0.6})
    assert out["score"] == 0.0


def test_max_score_is_one(seeded):
    out = score(seeded, {"category": "toiletries", "merchant": "X", "amount_minor": 5000}, {"confidence": 0.1})
    assert out["score"] == 0.65  # first_of_kind + near_cap + low_confidence (no history for price/vendor comparisons)


def test_only_executed_same_kind_history_counts(seeded):
    add_purchase(seeded, days_ago=3, category="drinks", merchant="FreshCart", amount_minor=100, status="blocked")
    add_purchase(seeded, days_ago=3, category="household", merchant="FreshCart", amount_minor=100)
    assert score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 100})["score"] == 0.3


def test_future_receipts_ignored_and_deterministic(seeded):
    add_purchase(seeded, days_ago=-3, category="drinks", merchant="FreshCart", amount_minor=100)
    a = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 100})
    b = score(seeded, {"category": "drinks", "merchant": "FreshCart", "amount_minor": 100})
    assert a == b and a["score"] == 0.3


def test_read_only_tools_score_zero(seeded):
    assert score(seeded, {"query": "cola"}, tool="Supplies___search_products") == {"score": 0.0, "top_reason": None}


def test_no_cap_means_no_near_cap(store, pinned_now):
    out = score(store, {"category": "drinks", "merchant": "m", "amount_minor": 99999})
    assert out["score"] == 0.3
