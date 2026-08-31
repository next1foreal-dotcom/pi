// G-394 完全访问权限档 = Claude Code auto mode 的 Cedar 对等物。
// 这是 Fei 亲自选择的「完全访问权限」档：关掉 Cedar 的具名许可门，destructive 与否都放行。
// 启用：进程启动时 HER_CEDAR_PROFILE=full（env 只在启动时定，会话内改不到）。
// 它不是沙箱——它关掉的是 Cedar 的具名许可门，不改变她自己的纪律与 automode 拒绝层。
// Fei 2026-08-31 点单「完全访问权限这两个选项就够了」。

@id("allow_memory_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
);

// 完全访问不等于允许自毁:这些 forbid 在任何档下都成立。
// 逐条照抄自 her-trust.cedar 的 forbid_anchor_write。

@id("forbid_anchor_write")
forbid(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when {
  resource.destructive == true &&
  resource has anchorPath &&
  resource.anchorPath == true
};
