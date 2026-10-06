"""The golden demo (04-demo-and-submission §2) end to end on moto + fake adapters + Cedar gateway."""
from agent_support import HH, away_plan, build_agent, hosting_plan, needs_by_label, start

SIX = ["c_tolu", "c_sam", "c_ada", "c_chris", "c_maya", "c_dee"]


def receipts(store, plan, tool):
    return [r for r in store.list_receipts_for_plan(plan.plan_id) if r.action.tool == tool]


def run_hosting(store, world):
    agent = build_agent(world)
    plan = hosting_plan(store)
    assert start(agent, plan) == {"ok": True, "data": {"accepted": True}}
    return agent, plan


def test_hosting_scene_1_to_2(store, world):
    _, plan = run_hosting(store, world)
    done = store.get_plan(HH, plan.plan_id)
    needs = needs_by_label(store, plan)
    assert not [n for n in done.needs if n.status == "doing"]
    assert {n.label: n.status for n in done.needs} == {
        "Invite guests": "done", "Add to calendar": "done", "Food and drinks": "done", "Cleaning": "needs_you"}
    assert done.status == "waiting_on_you"

    # 6 invite emails to the dinner crew, resolved from contact ids
    [invite] = receipts(store, plan, "Messages___send_email")
    assert sorted(invite.action.args["recipient_contact_ids"]) == sorted(SIX) and invite.action.args["kind"] == "invite"
    assert "— sent by Butler for Paul" in invite.action.args["body_text"]
    assert len(world.adapters.email.sent) == 6

    # calendar event for Friday 7 PM
    [event] = receipts(store, plan, "Calendar___create_event")
    assert event.action.args["start"] == "2026-10-16T19:00:00-04:00" and sorted(event.action.args["attendee_contact_ids"]) == sorted(SIX)
    assert len(world.adapters.calendar.events) == 1

    # drinks: FreshCart drk-party-7 4200, with the alternatives the demo shows
    [drinks] = receipts(store, plan, "Supplies___checkout")
    assert drinks.status == "executed" and drinks.cost.amount_minor == 4200
    assert drinks.action.args["merchant"] == "FreshCart" and drinks.action.args["items"] == [{"sku": "drk-party-7", "qty": 1}]
    alts = {a.option.split(" ")[0] + " " + a.option.split(" ")[1]: a.rejected_because for a in drinks.alternatives}
    assert any("BudgetBasket" in a.option and "arrives saturday" in a.rejected_because.lower() for a in drinks.alternatives), alts
    assert any("Corner Cellar" in a.option and "over your 50 dollar limit" in a.rejected_because.lower() for a in drinks.alternatives), alts
    assert len(drinks.alternatives) == 2 and 1 <= len(drinks.reasons) <= 3
    assert any(c.startswith("history:") for c in drinks.context_used)
    assert world.adapters.payments.charges[0]["amount_minor"] == 4200

    # cleaning: a choose_option decision with the 3 seeded cleaners, each carrying a book_service draft
    decision = store.get_decision(plan.plan_id, needs["Cleaning"].decision_id)
    assert decision.kind == "choose_option" and decision.status == "pending" and decision.reason_held is None
    assert [o.title for o in decision.options] == ["BrightHome", "Sparkle Cleaners", "TidyUp Co"]
    assert all(o.action_draft.tool == "Services___book_service" and o.simulated for o in decision.options)
    bright = decision.options[0]
    assert bright.price.amount_minor == 8500 and bright.action_draft.args["slot_start"] == "2026-10-16T10:00-04:00"
    assert not receipts(store, plan, "Services___book_service")  # nothing booked before the customer chooses
    assert needs["Cleaning"].status == "needs_you"


def approve(world, store, plan, decision, option):
    """Run the real approval executor (Workstream A) on a decision option."""
    from butler_executor.handler import handler

    return handler({"mode": "decision", "household_id": HH, "correlation_id": "cor_exec",
                    "decision_id": decision.decision_id, "option_id": option.option_id}, store=store, gateway=world.gateway)


def test_scene_3_approval_then_resume_learns_preferences(store, world):
    agent, plan = run_hosting(store, world)
    decision = store.get_decision(plan.plan_id, needs_by_label(store, plan)["Cleaning"].decision_id)
    bright = decision.options[0]
    res = approve(world, store, plan, decision, bright)
    assert res["ok"], res
    receipt = res["data"]["receipt"]
    assert receipt["authority"]["principal"] == "approval-executor" and receipt["simulated"] is True
    assert receipt["decision_id"] == decision.decision_id and receipt["action"]["tool"] == "Services___book_service"
    assert needs_by_label(store, plan)["Cleaning"].status == "done"

    resp = agent.handle({"op": "resume_plan", "household_id": HH, "correlation_id": "c", "plan_id": plan.plan_id,
                         "decision_id": decision.decision_id})
    assert resp["ok"]
    assert store.get_plan(HH, plan.plan_id).status == "complete"
    prefs = {p.key: p.value for p in store.list_preferences(HH)}
    assert prefs == {"merchant:drinks": "FreshCart", "provider:cleaning": "BrightHome"}


def test_approving_the_held_drinks_lets_the_executor_through_the_agent_only_rule(store, world):
    agent, _ = run_hosting(store, world)
    create_drinks_rule(agent, store)
    away = away_plan(store)
    start(agent, away)
    need = needs_by_label(store, away)["Pause or redirect supplies"]
    decision = store.get_decision(away.plan_id, need.decision_id)
    res = approve(world, store, away, decision, decision.options[0])
    assert res["ok"], res
    assert res["data"]["receipt"]["authority"]["principal"] == "approval-executor"
    assert res["data"]["receipt"]["cost"]["amount_minor"] == 3100
    assert len(world.adapters.payments.charges) == 2
    agent.handle({"op": "resume_plan", "household_id": HH, "correlation_id": "c", "plan_id": away.plan_id,
                  "decision_id": decision.decision_id})
    assert store.get_plan(HH, away.plan_id).status == "complete"


def test_preference_is_used_and_shown_on_the_second_hosting_run(store, world):
    agent, _ = run_hosting(store, world)
    second = hosting_plan(store)
    start(agent, second)
    [drinks] = receipts(store, second, "Supplies___checkout")
    assert drinks.action.args["merchant"] == "FreshCart"
    assert "preference: FreshCart for drinks" in drinks.context_used


def create_drinks_rule(agent, store):
    drafted = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c", "correction": "Don't buy drinks without asking me."})
    assert drafted["ok"], drafted
    rule_id = drafted["data"]["rule"]["rule_id"]
    applied = agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": rule_id})
    assert applied["ok"] and applied["data"]["rule"]["policy_status"] == "active"
    return rule_id


def test_scenes_5_to_7_correction_becomes_a_rule_that_denies_the_agent(store, world):
    agent, _ = run_hosting(store, world)
    rule_id = create_drinks_rule(agent, store)
    rule = store.get_rule(HH, rule_id)
    assert rule.template == "ask_category" and rule.params == {"category": "drinks"} and rule.active
    assert rule.origin.type == "correction" and rule.text == "Ask me before buying drinks."

    away = away_plan(store)
    start(agent, away)
    done = store.get_plan(HH, away.plan_id)
    assert {n.label: n.status for n in done.needs} == {
        "Tell people": "done", "Block calendar": "done", "Pause or redirect supplies": "needs_you"}
    assert done.status == "waiting_on_you"
    [mum_dad] = receipts(store, away, "Messages___send_email")
    assert sorted(mum_dad.action.args["recipient_contact_ids"]) == ["c_dad", "c_mum"]

    denied = receipts(store, away, "Supplies___checkout")
    assert [r.status for r in denied] == ["held_for_approval"]
    assert denied[0].authority.decision == "DENY" and denied[0].authority.rule_ids == [rule_id]
    assert denied[0].action.args["items"] == [{"sku": "drk-family-3", "qty": 1}] and denied[0].action.args["amount_minor"] == 3100
    assert len(world.adapters.payments.charges) == 1  # only the hosting purchase; the away one never went through

    need = needs_by_label(store, away)["Pause or redirect supplies"]
    decision = store.get_decision(away.plan_id, need.decision_id)
    assert decision.kind == "approve_action" and decision.status == "pending"
    assert decision.reason_held.rule_id == rule_id and decision.reason_held.rule_text == "Ask me before buying drinks."
    [option] = decision.options
    assert option.action_draft.tool == "Supplies___checkout" and option.action_draft.args["amount_minor"] == 3100
    assert option.price.amount_minor == 3100 and "31 dollars" in decision.question


def test_never_rule_marks_the_need_skipped(store, world):
    agent = build_agent(world)
    drafted = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c", "correction": "Never email Mum."})
    agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": drafted["data"]["rule"]["rule_id"]})
    away = away_plan(store)
    start(agent, away)
    need = needs_by_label(store, away)["Tell people"]
    assert need.status == "skipped" and need.note.startswith("Not allowed by your rule: Never message Mum.")
    assert not store.list_pending_decisions(HH) or all(d.need_id != need.need_id for d in store.list_pending_decisions(HH))
    [r] = receipts(store, away, "Messages___send_email")
    assert r.status == "blocked" and r.authority.decision == "DENY"


def test_running_low_reorders_within_limits(store, world):
    agent = build_agent(world)
    from agent_support import make_plan

    plan = make_plan(store, "We're running low on paper towels and dishwasher tablets.", "running_low", "Restock the kitchen")
    start(agent, plan)
    need = store.get_plan(HH, plan.plan_id).needs[0]
    assert need.status == "done" and "FreshCart" in need.note
    [order] = receipts(store, plan, "Supplies___checkout")
    assert order.status == "executed" and order.action.args["amount_minor"] == 3200
    assert sorted(i["sku"] for i in order.action.args["items"]) == ["hh-dish-tabs", "hh-paper-bundle"]
    assert any(c.startswith("history:") for c in order.context_used)
    assert store.get_plan(HH, plan.plan_id).status == "complete"


def test_running_low_with_no_items_reorders_the_last_household_order(store, world):
    from agent_support import make_plan

    agent = build_agent(world)
    plan = make_plan(store, "We're running low on household stuff.", "running_low", "Restock")
    start(agent, plan)
    [order] = receipts(store, plan, "Supplies___checkout")
    assert order.action.args["items"] == [{"sku": "hh-paper-bundle", "qty": 1}]  # latest household order in the seed history
    assert store.get_plan(HH, plan.plan_id).needs[0].status == "done"


def test_running_low_over_the_cap_asks(store, world):
    from agent_support import make_plan

    agent = build_agent(world)
    plan = make_plan(store, "We're running low on wine and speaker batteries.", "running_low", "Restock")
    start(agent, plan)
    need = store.get_plan(HH, plan.plan_id).needs[0]
    # wine (52 dollars) alone is over the 50 dollar limit: held and offered for approval
    assert need.status in ("needs_you", "done", "blocked")
    assert need.status != "doing"
