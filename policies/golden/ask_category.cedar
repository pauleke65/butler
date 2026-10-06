@id("rule_golden")
forbid (
  principal,
  action == AgentCore::Action::"Supplies___checkout",
  resource is AgentCore::Gateway
)
when {
  principal.hasTag("sub") && principal.getTag("sub") == "{{AGENT_SUB}}" &&
  context has input && context.input has category && context.input.category == "drinks"
};
