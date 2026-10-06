@id("base-permit")
permit (principal, action, resource is AgentCore::Gateway)
when {
  principal.hasTag("sub") &&
  (principal.getTag("sub") == "{{AGENT_SUB}}" || principal.getTag("sub") == "{{EXECUTOR_SUB}}")
};
