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

// G-187 追加 — Fei 拍板 2026-08-02: 派得出就该停得掉。her_task_stop 只杀她自己派的
// 后台任务(stopBgTask 按 .her/tasks 的 id 定位,且跨主机的记录会拒停),不碰别的进程。
// her_task_continue 已预批同款 permit,但要等 C2 把工具真造出来再落——不提前加空 permit。
@id("permit_her_task_stop")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_task_stop"
);

// G-187 收尾 — Fei 2026-08-02 预批,工具落地(C2 `2176eff70`)且真身验证通过后同 commit 发证:
// 真 spawn 的 codex 任务捕到 codexSessionId、result.md 落盘、续跑真接上上下文(暗号 plum-7)。
// continue 只能续自己账本里、终态、且带 codexSessionId 的 codex 任务(continueBgTask 四道前置),
// 续不出新权限——它派的仍是一个受同样预算/并发/日额闸管的后台任务。
@id("permit_her_task_continue")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_task_continue"
);

// G-245 — Fei 拍板放行(2026-08-12「发」)。her_session_send 注册为 destructive:true
// (写记忆库、能触发要花钱的唤醒、把文字塞进另一个 agent 的系统提示词——与
// her_task_continue 同一副作用族),故上面的 allow_memory_tools 不覆盖它,建成即
// deny(运行时实证 deny matched=[])。阀门不在这里:收件方 drainInbox 对正文一律
// fenceUntrusted(伪造栅栏 8/11 已修)、唤醒走既有 event-wake gate(同 origin 只唤
// 一次、日额闸不变)、from 取自发送方自己的 sessionId 不可自报。只放这一个工具;
// 心跳档 her-trust-heartbeat.cedar 是独立策略集、不含具名 permit,发证不会漏进
// 无人值守轮。
@id("permit_her_session_send")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_session_send"
);
