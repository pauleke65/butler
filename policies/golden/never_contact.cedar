@id("rule_golden")
forbid (
  principal,
  action == AgentCore::Action::"Messages___send_email",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  context has input && context.input has recipient_contact_ids && context.input.recipient_contact_ids.contains("c_jordan")
};
