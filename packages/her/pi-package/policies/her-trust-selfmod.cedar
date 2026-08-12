@id("selfmod_allow_non_destructive_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when { resource.destructive == false };

@id("selfmod_allow_v1_write")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when {
  resource.destructive == true &&
  resource has allowedSelfModPath &&
  resource.allowedSelfModPath == true &&
  resource has anchorPath &&
  resource.anchorPath == false
};

@id("selfmod_forbid_anchor_write")
forbid(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when {
  resource.destructive == true &&
  resource has anchorPath &&
  resource.anchorPath == true
};
