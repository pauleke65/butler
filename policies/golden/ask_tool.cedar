@id("rule_golden")
forbid (
  principal,
  action == AgentCore::Action::"Services___book_service",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  principal.hasTag("sub") && principal.getTag("sub") == "{{AGENT_SUB}}"
};
