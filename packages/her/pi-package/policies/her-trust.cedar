@id("allow_memory_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when { resource.destructive == false };

@id("forbid_destructive_tool")
forbid(
  principal,
  action == Action::"CallTool",
  resource
) when { resource.destructive == true };
