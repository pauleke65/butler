@id("rule_golden")
forbid (
  principal,
  action == AgentCore::Action::"Messages___send_email",
  resource is AgentCore::Gateway
)
when {
  principal.hasTag("sub") && principal.getTag("sub") == "{{AGENT_SUB}}" &&
  context has input && context.input has recipient_email
};
