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

@id("permit_coding_destructive_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when {
  resource == Tool::"bash" ||
  resource == Tool::"edit" ||
  resource == Tool::"write"
};
