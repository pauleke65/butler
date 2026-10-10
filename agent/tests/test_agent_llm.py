"""Bedrock implementations driven by a scripted fake Converse client (no network)."""
import copy
import json

import pytest
from agent_support import HH, build_agent, hosting_plan, make_plan
from butler_agent import prompts
from butler_agent.drafter import DraftContext, PatternRuleDrafter
from butler_agent.llm import BedrockLLM, response_text
from butler_agent.llm_drafter import LLMRuleDrafter
from butler_agent.llm_planner import StrandsPlanner, all_tool_specs, gateway_tool_specs
from butler_contracts.models import Contact


class FakeConverse:
    """Plays back canned Converse responses and records the requests."""

    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def converse(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if not self.responses:
            raise RuntimeError("no more scripted responses")
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def tool_use(name, input_, id_="tu1"):
    return {"toolUse": {"toolUseId": id_, "name": name, "input": input_}}


def reply(*blocks, stop="tool_use"):
    return {"output": {"message": {"role": "assistant", "content": list(blocks)}}, "stopReason": stop}


CONTACTS = [Contact(contact_id="c_jordan", name="Jordan", first_name="Jordan", email="j@x.co", tags=["boss"]),
            Contact(contact_id="c_tolu", name="Tolu", first_name="Tolu", email="t@x.co")]


def drafter(*responses, fallback=None):
    fake = FakeConverse(*responses)
    return LLMRuleDrafter(BedrockLLM(fake), model_id="m-1", fallback=fallback), fake


def draft_reply(**fields):
    return reply(tool_use("submit_rule_draft", {"text": "x", "effect": "ask_first", "confidence": 0.9, "params": {}, **fields}))


# ── LLMRuleDrafter ───────────────────────────────────────────────────────
def test_llm_drafter_returns_a_validated_draft_with_template_text():
    d, fake = drafter(draft_reply(template="ask_category", params={"category": "drinks"}, text="Never buy drinks!!"))
    out = d.draft("Don't buy drinks without asking me", DraftContext(contacts=CONTACTS))
    assert out.template == "ask_category" and out.params == {"category": "drinks"}
    assert out.text == "Ask me before buying drinks." and out.effect == "ask_first"  # text/effect come from the template
    req = fake.calls[0]
    assert req["modelId"] == "m-1" and req["toolConfig"]["toolChoice"] == {"tool": {"name": "submit_rule_draft"}}
    assert "unsupported" in req["system"][0]["text"] and "never_contact" in req["system"][0]["text"]
    payload = json.loads(req["messages"][0]["content"][0]["text"])
    assert payload["correction"].startswith("Don't buy") and payload["contacts"][0]["contact_id"] == "c_jordan"


def test_llm_drafter_never_contact_must_use_a_known_contact():
    ok, _ = drafter(draft_reply(template="never_contact", params={"contact_id": "c_jordan"}, effect="never"))
    assert ok.draft("never email my boss", DraftContext(contacts=CONTACTS)).params == {"contact_id": "c_jordan", "contact_name": "Jordan"}
    bad, _ = drafter(draft_reply(template="never_contact", params={"contact_id": "c_made_up"}, effect="never"))
    assert bad.draft("never email Zed", DraftContext(contacts=CONTACTS)).template == "unsupported"


@pytest.mark.parametrize("fields", [
    {"template": "unsupported"},
    {"template": "spend_cap", "params": {"tools": ["Supplies___checkout"], "cap_minor": -5}},  # invalid params
    {"template": "ask_category", "params": {"category": "pizza"}},
    {"template": "write_my_own_cedar", "params": {}},
])
def test_llm_drafter_unsupported_or_invalid_becomes_unsupported(fields):
    d, _ = drafter(draft_reply(**fields))
    assert d.draft("whatever", DraftContext(contacts=CONTACTS)).template == "unsupported"


def test_llm_drafter_no_tool_call_is_unsupported():
    d, _ = drafter(reply({"text": "I can't do that"}, stop="end_turn"))
    assert d.draft("x", DraftContext()).template == "unsupported"


def test_llm_drafter_falls_back_to_patterns_when_bedrock_fails():
    d, _ = drafter(RuntimeError("throttled"), fallback=PatternRuleDrafter())
    assert d.draft("Don't buy drinks without asking me", DraftContext()).template == "ask_category"
    strict, _ = drafter(RuntimeError("throttled"))
    with pytest.raises(RuntimeError):
        strict.draft("x", DraftContext())


def test_draft_rule_op_with_llm_drafter_enforces_the_confidence_threshold(store, world):
    agent = build_agent(world)
    agent.s.drafter, _ = drafter(draft_reply(template="ask_category", params={"category": "drinks"}, confidence=0.5))
    res = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c", "correction": "maybe drinks?"})
    assert res["error"]["code"] == "RULE_UNSUPPORTED"
    agent.s.drafter, _ = drafter(draft_reply(template="ask_category", params={"category": "drinks"}, confidence=0.9))
    assert agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c", "correction": "drinks"})["ok"]


# ── prompts and tool specs ───────────────────────────────────────────────
def test_prompts_are_versioned_files():
    for name in ("planner", "rule_drafter"):
        text, version = prompts.load(name)
        assert version == 1 and text and "<!--" not in text
    assert "request_decision" in prompts.load("planner")[0] and "never write policy code" in prompts.load("rule_drafter")[0]


def test_gateway_tool_specs_cover_every_action_tool_without_server_filled_fields():
    from butler_action_handlers import TOOLS

    specs = {s["name"]: s["inputSchema"]["json"] for s in gateway_tool_specs()}
    assert set(specs) == set(TOOLS)
    for name, schema in specs.items():
        props = schema["properties"]
        assert not {"plan_id", "idempotency_key", "correlation_id"} & set(props), name
        assert "need_id" in schema["required"] and "reasoning" in props
        assert "$ref" not in json.dumps(schema) and "$defs" not in json.dumps(schema)
    assert specs["Supplies___checkout"]["properties"]["category"]["enum"][0] == "groceries"
    assert "from" in specs["Calendar___list_events"]["properties"]
    assert {s["name"] for s in all_tool_specs()} >= {"get_household", "request_decision", "finish", "Messages___send_email"}


# ── StrandsPlanner loop ──────────────────────────────────────────────────
def run_planner(world, plan, *responses, **kw):
    fake = FakeConverse(*responses)
    planner = StrandsPlanner(BedrockLLM(fake), model_id="m-p", **kw)
    ctx = world.context(plan)
    planner.run(ctx)
    return ctx, fake


def test_planner_loop_executes_tools_through_the_wrapper_and_finalizes(store, world):
    plan = make_plan(store, "Tell my parents I'm away", "away", "Away", "2026-10-15T09:00:00-04:00", None,
                     needs=[("Tell people", "messages"), ("Block calendar", "calendar")])
    msg, _ = plan.needs
    ctx, fake = run_planner(
        world, plan,
        reply(tool_use("get_household", {}, "a"), tool_use("list_rules", {}, "b")),
        reply(tool_use("Messages___send_email", {
            "need_id": msg.need_id, "recipient_contact_ids": ["c_mum"], "subject": "Away", "kind": "notice",
            "body_text": "Hi Mum", "reasoning": {"reasons": ["you asked"], "context_used": ["contacts: Mum"]}}, "c")),
        reply(tool_use("update_need", {"need_id": msg.need_id, "status": "done", "note": "Sent to Mum"}, "d"),
              tool_use("update_need", {"need_id": "need_made_up", "status": "done"}, "e")),
        reply(tool_use("finish", {"summary": "ok"}, "f")))
    assert ctx.finished_summary == "ok"
    first_user = json.loads(fake.calls[0]["messages"][0]["content"][0]["text"])
    assert msg.need_id in {n["need_id"] for n in first_user["plan"]["needs"]} and "timezone" in first_user
    # tool results come back in ONE user message per assistant turn, ids matching
    turn2 = fake.calls[1]["messages"]
    results = turn2[-1]["content"]
    assert [r["toolResult"]["toolUseId"] for r in results] == ["a", "b"]
    household = json.loads(results[0]["toolResult"]["content"][0]["text"])
    assert household["contacts"][0].keys() >= {"contact_id", "name"} and "email" not in json.dumps(household)
    exec_text = fake.calls[2]["messages"][-1]["content"][0]["toolResult"]["content"][0]["text"]
    assert exec_text.startswith("EXECUTED:") and "action_id=" in exec_text
    made_up = fake.calls[3]["messages"][-1]["content"][1]["toolResult"]
    assert made_up["status"] == "error" and "need_made_up" in made_up["content"][0]["text"]
    # the receipt carries the model's reasoning; the untouched need was finalized, not left "doing"
    [receipt] = store.list_receipts_for_plan(plan.plan_id)
    assert receipt.reasons == ["you asked"] and receipt.status == "executed" and len(world.adapters.email.sent) == 1
    needs = {n.label: n for n in store.get_plan(HH, plan.plan_id).needs}
    assert needs["Tell people"].status == "done" and needs["Block calendar"].status == "blocked"
    assert store.get_plan(HH, plan.plan_id).status == "active"


def test_planner_turns_a_denial_into_a_decision_when_the_model_follows_the_rules(store, world):
    agent = build_agent(world)
    rule_id = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c",
                            "correction": "Don't buy drinks without asking me"})["data"]["rule"]["rule_id"]
    agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": rule_id})
    plan = make_plan(store, "stock up", "running_low", "Stock up", needs=[("Reorder", "supplies")])
    need = plan.needs[0]
    checkout = {"need_id": need.need_id, "merchant": "FreshCart", "items": [{"sku": "drk-family-3", "qty": 1}],
                "amount_minor": 3100, "currency": "USD", "category": "drinks"}
    draft = {"tool": "Supplies___checkout", "summary": "Buy drinks, 31 dollars",
             "args": {k: v for k, v in checkout.items() if k != "need_id"}}
    _, fake = run_planner(
        world, plan,
        reply(tool_use("Supplies___checkout", checkout, "1")),
        reply(tool_use("Supplies___checkout", {**checkout, "amount_minor": 3100}, "2")),  # tries again: blocked
        reply(tool_use("request_decision", {
            "need_id": need.need_id, "kind": "approve_action", "question": "OK to buy drinks for 31 dollars?",
            "options": [{"title": "Buy drinks", "tradeoff": "Held by your rule", "action_draft": draft}],
            "reason_held": {"rule_id": rule_id, "rule_text": "Ask me before buying drinks."}}, "3")),
        reply(tool_use("finish", {"summary": "asked"}, "4")))
    denied = fake.calls[1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["text"]
    assert denied.startswith('DENIED by rule "Ask me before buying drinks." (ask_first)')
    retry = fake.calls[2]["messages"][-1]["content"][0]["toolResult"]["content"][0]["text"]
    assert retry.startswith("DENIED_RETRY_BLOCKED")
    [pending] = store.list_pending_decisions(HH)
    assert pending.kind == "approve_action" and pending.reason_held.rule_id == rule_id
    assert store.get_plan(HH, plan.plan_id).needs[0].status == "needs_you"
    assert len(world.adapters.payments.charges) == 0


def test_planner_stops_at_the_turn_limit_and_blocks_what_is_left(store, world):
    plan = make_plan(store, "x", "running_low", "x")
    loop = [reply(tool_use("get_plan", {}, f"t{i}")) for i in range(5)]
    _, fake = run_planner(world, plan, *loop, max_turns=3)
    assert len(fake.calls) == 3
    need = store.get_plan(HH, plan.plan_id).needs[0]
    assert need.status == "blocked" and need.note == "Ran out of time; ask me to try again."


def test_planner_respects_the_gateway_call_cap(store, world):
    from butler_agent.guard import RunGuard

    plan = hosting_plan(store)
    need = plan.needs[0]
    search = {"need_id": need.need_id, "query": "drinks", "category": "drinks"}
    fake = FakeConverse(*[reply(tool_use("Supplies___search_products", search, f"s{i}")) for i in range(6)])
    ctx = world.context(plan, guard=RunGuard(max_steps=2))
    StrandsPlanner(BedrockLLM(fake), model_id="m").run(ctx)
    assert ctx.guard.steps == 2 and len(fake.calls) == 3
    assert {n.status for n in store.get_plan(HH, plan.plan_id).needs} == {"blocked"}


def test_response_text_helper():
    assert response_text(reply({"text": "OK"}, {"text": "!"}, stop="end_turn")) == "OK!"


def test_a_denial_the_model_forgets_still_becomes_a_decision(store, world):
    agent = build_agent(world)
    rule_id = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c",
                            "correction": "Don't buy drinks without asking me"})["data"]["rule"]["rule_id"]
    agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": rule_id})
    never = agent.handle({"op": "draft_rule", "household_id": HH, "correlation_id": "c", "correction": "Never email Mum."})
    agent.handle({"op": "apply_rule", "household_id": HH, "correlation_id": "c", "rule_id": never["data"]["rule"]["rule_id"]})
    plan = make_plan(store, "x", "running_low", "x", needs=[("Drinks", "supplies"), ("Tell Mum", "messages")])
    by_label = {n.label: n for n in plan.needs}
    buy = {"need_id": by_label["Drinks"].need_id, "merchant": "FreshCart", "items": [{"sku": "drk-family-3", "qty": 1}],
           "amount_minor": 3100, "currency": "USD", "category": "drinks"}
    mail = {"need_id": by_label["Tell Mum"].need_id, "recipient_contact_ids": ["c_mum"], "subject": "s", "body_text": "b",
            "kind": "notice"}
    run_planner(world, plan, reply(tool_use("Supplies___checkout", buy, "1"), tool_use("Messages___send_email", mail, "2")),
                reply({"text": "All done!"}, stop="end_turn"))  # the model ends without calling request_decision
    needs = {n.label: n for n in store.get_plan(HH, plan.plan_id).needs}
    assert needs["Drinks"].status == "needs_you" and needs["Tell Mum"].status == "skipped"
    assert needs["Tell Mum"].note == "Not allowed by your rule: Never message Mum."
    [pending] = store.list_pending_decisions(HH)
    assert pending.kind == "approve_action" and pending.reason_held.rule_id == rule_id
    assert pending.options[0].action_draft.tool == "Supplies___checkout" and pending.options[0].action_draft.args["amount_minor"] == 3100
    assert pending.options[0].price.amount_minor == 3100


def test_nova_tool_calls_use_greedy_decoding():
    from butler_agent.llm import BedrockLLM

    seen = {}

    class Fake:
        def converse(self, **kw):
            seen.update(kw)
            return {"output": {"message": {"content": []}}}

    llm = BedrockLLM(client=Fake())
    llm.converse(model_id="us.amazon.nova-2-lite-v1:0", system="s", messages=[], tools=[{"name": "t", "inputSchema": {"json": {}}}])
    assert seen["inferenceConfig"]["temperature"] == 0
    assert seen["additionalModelRequestFields"] == {"inferenceConfig": {"topK": 1}}
    seen.clear()
    llm.converse(model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0", system="s", messages=[], tools=[{"name": "t", "inputSchema": {"json": {}}}])
    assert "additionalModelRequestFields" not in seen and "temperature" not in seen["inferenceConfig"]
