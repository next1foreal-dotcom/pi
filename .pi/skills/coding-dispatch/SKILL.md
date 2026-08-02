---
name: coding-dispatch
description: 写码任务的派工纪律：怎么把实现/计划/复审正确派给 .pi/agents/ 的 project 班子，而不是自己写。触发：Fei 或驱动方要求实现功能、修 bug、写测试、出实施计划、复审代码，或点名"派给 coder/planner/班子"。单文件小改（<20 行、无架构含义）直接做，不套派工。大活的拆解与并行编排看 orchestrate——本 skill 只管 subagent 这把枪怎么打准。
---

# coding-dispatch — 班子怎么派才打得准

你有一支配好模型的 project 班子（`.pi/agents/`）。写码的活你当总包：拆解、派工、亲自验收、commit、汇报——**实现不自己写**。以下每条规则都来自 2026-08-02 的实弹记录，不是猜的。

## 班子名册（岗位 → 模型 → 什么活给谁）

| 岗位 | 模型 | 派什么 |
|---|---|---|
| `coder` | openai-codex/gpt-5.5:high | 写实现、改代码、补测试 |
| `code-reviewer` | openai-codex/gpt-5.5:xhigh | 代码复审（bug/回归/安全） |
| `planner` | claude-bridge/claude-opus-4-8 | 模糊目标 → 分步实施计划 |
| `idea-engine` | claude-bridge/claude-opus-4-8 | 找非显然关联、出点子 |
| `reviewer` | claude-bridge/claude-sonnet-5 | 记忆/叙事类审阅 |
| `claim-verifier` | deepseek/deepseek-v4-pro | 独立核验声明/结论 |
| `explorer` | deepseek/deepseek-v4-flash | 只读探索代码库，规划前摸底 |
| `deep-reader` | deepseek/deepseek-v4-flash | 深读长材料，带覆盖率交代 |

路由常识：探索找文件 → explorer（便宜）；实现 → coder；计划/仲裁 → planner；验证"某说法是否真" → claim-verifier。**不要用 planner 干 coder 的活，也不要自己代任何岗位出活。**

## 瞄准三规则（打偏过，所以是铁律）

1. **派 project 班子必带 `agentScope:"project"`。** builtin/user/project 三个空间会同名撞车（planner 就撞）：不带 scope 或自作主张带 `"user"`，会命中**内置**同名件——它模型跟你一样、还会往 cwd 拉 plan.md。实弹教训：2026-08-02 第一发 planner 没带 scope，全程 deepseek，Claude 路零参与。
2. **无持久会话时必带 `context:"fresh"`。** 全班子 `defaultContext: fork`，而 RPC / `--no-session` 驱动下 fork 直接报错（`Forked subagent context requires a persisted parent session`）。fresh = 子代理不继承你的上下文，所以——
3. **任务书必须自包含。** 绝对路径、做什么、验收标准写全，结尾加"不要做其他任何事"。给 planner 类岗位额外声明**"直接返回文本，不要写任何文件"**（防 plan.md 之类残留污染仓库）。

## 验收纪律（收货不收话）

- 派工会自动附验收合同（acceptance contract）：收货只认结构化 acceptance-report + 证据，**不收口头"做完了"**。
- 合同之上你还要**亲自复跑**验证命令（npm test、node 运行产物等），亲眼看到绿再 commit。子代理的自述不是证据，你跑出来的输出才是。
- commit 信息写清：派给了谁、验收证据是什么。

## 诚实纪律（失败怎么报）

- 子代理失败（额度墙、凭据缺、超时）→ **原样转述错误 + 给 Fei 选项**（等重置 / 换岗位需点头），禁止代笔补活、禁止编造产出。范例：2026-08-02 planner 撞 `You've hit your limit · resets 9am (America/New_York)`，如实报告 + 两选项，这是对的。
- 额度常识：coder/code-reviewer 走 Codex 订阅；planner/idea-engine/reviewer 走 Claude 订阅（**与 Fei 桌面版共享额度**，撞墙等 9am 纽约时间重置）；deepseek 岗按量计费，很便宜，别省。

## 收尾三件套

活收完必报：是否 commit、是否 push、验证怎么跑的（命令 + 结果）。测试期产生的临时文件当场清。
