@id("allow_memory_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when { resource.destructive == false };

@id("permit_artifact_publish")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"artifact_publish"
);

@id("forbid_destructive_tool")
forbid(
  principal,
  action == Action::"CallTool",
  resource
) when { resource.destructive == true } unless { resource == Tool::"artifact_publish" };
