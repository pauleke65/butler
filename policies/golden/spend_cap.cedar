@id("rule_golden")
forbid (
  principal,
  action in [AgentCore::Action::"Supplies___checkout", AgentCore::Action::"Services___book_service"],
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.hasTag("sub") && principal.getTag("sub") == "{{AGENT_SUB}}" &&
  context has input && context.input has amount_minor && context.input.amount_minor > 5000
};
