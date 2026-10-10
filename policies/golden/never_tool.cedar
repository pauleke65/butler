@id("rule_golden")
forbid (
  principal,
  action == AgentCore::Action::"Supplies___checkout",
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
);
