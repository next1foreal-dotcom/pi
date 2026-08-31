// G-377 讨论模式 = 只读策略集。
// 启用：进程启动时 HER_CEDAR_PROFILE=plan（env 只在启动时定，会话内改不到，防篡改天生成立）。
// Fei 2026-08-31 点单「先讨论真锁」。

@id("allow_memory_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when { resource.destructive == false };

@id("permit_her_session_send")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_session_send"
);

// 故意没发证（不是遗漏；与心跳档「无具名 permit 不漏证」同理）：
// bash / write / edit / her_task_spawn / her_selfmod
// 以及 default 档里其它 destructive 具名 permit（artifact_publish、
// permit_coding_destructive_tools、her_task_stop、her_task_continue、
// her_schedule_wakeup、her_tool_declare、her_tool_call、subagent 等）
// 全部走 Cedar 默认拒。后人勿当漏证补。
