@id("rule_golden")
forbid (
  principal,
  action in [AgentCore::Action::"Calendar___update_event", AgentCore::Action::"Calendar___delete_event"],
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
)
when {
  context has input && context.input has event_owner && context.input.event_owner == "human"
};
