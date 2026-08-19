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

// Sol 2026-08-13: the old form was unconditional — any bash/edit/write matched,
// so a name-only tool_call hook (no path attrs) ALLOW-wrote SOUL.md. Do not
// delete this permit (coding dies). Scope it: if the hook classified a target
// as an anchor, this permit does not apply; forbid_anchor_write still wins.
// usedTools / bash with no path omit the attr (`!(resource has anchorPath)`),
// so project writes and pathless shell still code. Computed bash remains a hole.
@id("permit_coding_destructive_tools")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource
) when {
  (resource == Tool::"bash" ||
   resource == Tool::"edit" ||
   resource == Tool::"write") &&
  (!(resource has anchorPath) || resource.anchorPath == false)
};

// G-257 追补 — 2026-08-13 活体探针实证:注册在案的 write 靠上面的 permit 整文件
// 覆写了真店 SOUL.md(audit ALLOW permit_coding_destructive_tools),因为 tool_call
// 闸从不看目标路径。此条与 selfmod_forbid_anchor_write 同形:forbid 压过一切 permit,
// 锚路径(SOUL/FACTS/CONTEXT/evals/policies/.githooks/.env)对破坏性工具一律拒。
// bash/powershell 的 command 字符串会扫 path 候选和锚路径子串(含绝对 her-memory
// 路径);漏解析的绕法仍靠 git 闸 + 人审。
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

// G-284 工具信任梯 — Fei 拍板发证(2026-08-19)。取证结论先于直觉:她**早就**有 bash
// 在所有非锚路径上(上面 permit_coding_destructive_tools),所以自造工具是 **0 能力增量**
// ——它只能比被包装者更窄(注册期 wider-than-wrapped 直接拒;可包装清单只有 ["bash"])。
// 这两条证买到的不是新能力,是把一次宽口径不透明的 `bash -c "<任意>"` 换成一次具名、
// 有作用域、账本读得懂的调用(审计带 origin: "agent-made")。**这是降权机制,不是升权机制**
// ——ADR-0005 记录了这个反直觉结论和它的取证。
//
// 发证后仍然不可能的事(逐条核过,不是推断):
//   · 锚层:forbid_anchor_write 对 destructive+锚路径开火,forbid 压过一切 permit。
//   · 无人值守轮:her-trust-heartbeat.cedar 是**独立策略集**,只放行 destructive == false、
//     明确 forbid destructive;两个工具都注册为 destructive:true ⇒ **这张证漏不进心跳轮**。
//     (与 her_session_send 发证时同一条安全性质,不是新论证。)
//   · 留存:注册表纯内存,进程退出即消失;不进 governedTools 的可调用面,可调用性只来自
//     那张临时注册表。
//
// 防反悔护栏:将来一定有人想「她已经用了 50 次了,自动转正吧」或「反正只是包装,放宽点
// 让它能包 edit/write 吧」。本处记录:转正是**人审**、永不靠调用次数攒;可包装清单收窄到
// bash 是有意的。这两条都是把收窄机制反向变成扩权机制。
@id("permit_her_tool_declare")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_tool_declare"
);

@id("permit_her_tool_call")
permit(
  principal == Agent::"samantha",
  action == Action::"CallTool",
  resource == Tool::"her_tool_call"
);
