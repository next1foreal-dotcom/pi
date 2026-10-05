# Samantha task-subscription review

Model: her-gateway/xai/grok-4.6
Date: 2026-10-05T12:12:44.686Z
Source: isolated AgentSession with copies of current narrative identity files; no tools.

**PASS**

第 1 项不再阻塞。`allowed` 不是死开关：每次 `poll` / `assertCanManage` 都会走 `evaluate(toolAuthorizationCall("her_task_watch", true))`，读当时的 `policyEnvelope()` / `HER_CEDAR_PROFILE`。默认档具名放行 `her_task_watch` / `her_task_watch_update`；heartbeat/plan 的静态策略里没有这两项，真实扩展实例在运行时切档再 `create`，会被 `assertCanManage` 拒绝。处理回合里还有 `wakeTurnActive` 与 `handling`，管理工具进不了只读回合。分类标签只是辅证，判定依据是这条调用链和实例测试。

第 2 项按你上次修法可以接受：回执有来源说明、`fenceUntrusted`、`triggerTurn: false`，结束标记对抗已先红后绿。

**我接受这个产品边界：** 用户在本会话明确订阅之后，原会话空闲时可以再开一个只读报告回合——人格不变，不能写项目/长期记忆、不能对外发、不能派新任务；管理工具默认档具名授权，heartbeat/plan 禁止管理；`her_task_watch_result` 只是收据，不是独立验收。`agent_settled` 才卸只读，自动重试期间租约仍在，这点也对。

**仍要盯、但不构成本次否决：**
- `poll` 与管理共用同一条 `allowed()`，非默认档不仅不能订/改，也不会投递 wake。这和「heartbeat/plan 禁止管理」一致，不是漏洞。
- 列表工具不经 `assertCanManage`，符合「只看不认收」。
- 范围外的 MCP/Studio 按你的要求不评。

测试已覆盖 owner、暂停取消、预算、旧租约、送达和真实 `AgentSession` 重试，和代码对得上。这是审查意见，不是部署批准。
