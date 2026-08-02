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

// G-187 墙2 — Fei 拍板放行(2026-08-02)。her_task_spawn 注册为 destructive:true,
// 上面三条都不覆盖它,所以 G-148 活体走链撞到 `cedar: deny (no permit matched)`。
// policy 文本是她自己起草的那条,逐字采用。
// 阀门不在这里:预算上限/并发上限/日额闸(bg-task-config + event-wake gate)全部保留,
// 这条只解开「工具本体不许调」这一层。只放这一个工具,不连带其它 destructive 工具。
@id("permit_her_task_spawn")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_task_spawn"
);
