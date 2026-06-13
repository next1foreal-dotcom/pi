@id("heartbeat_allow_non_destructive_tools")
permit(principal == Agent::"samantha", action == Action::"CallTool", resource)
  when { resource.destructive == false };

@id("heartbeat_forbid_destructive_tools")
forbid(principal, action == Action::"CallTool", resource)
  when { resource.destructive == true };
