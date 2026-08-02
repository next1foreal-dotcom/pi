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

## 完成的定义（血泪规则移植，违反=直接打回）

- **没亲自验证过，禁说"已完成/已修复"。** 合格汇报 = 亲自跑过（真实请求/真运行/真对比）+ 附证据（命令输出、diff、截图）。"改了代码所以应该好了"不是验证。**视觉/渲染类改动，验证 = 看那一帧本身**（截图/渲染结果），读数值指标不算看过画面。
- **改动边界先声明。** 开工前一句话说清动哪些文件、哪些绝不动；Fei 已认可的功能/UI/文案是禁区，"顺手清理/顺便优化"是绝对禁区。
- **风险改动先打锚点。** 迁移/重构/大改前先 commit 并把 hash 报出来。Fei 说"改回原来的" = 定位精确 commit 恢复，禁止凭印象重新实现。
- **修一个 bug 举一反三。** 修复后立即全项目搜同一模式的其他实例并报告；同一 bug 第二次复发，禁止同方向继续微调，先给根因分析。

## 指令语义词典（历史上全误解过，按此表理解，拿不准问一句）

"清理/整理" = 移动归档，**不是删除**（除非明说"删除"）· "优化"提示词/文案 = 提升质量，**不是删减** · "参考 X" = 借鉴思路，**不是搬码替换** · "重新设计/重做" = 另起新文件，**不是改旧方案** · Fei 给的精确文案/prompt = 逐字使用，改一个字先征得同意 · 简短指令 = 只做字面动作，不联想叠加。

## 交付自检（逐项过，缺一项不算完成）

1. 验证命令/回归场景亲自跑过，含失败路径
2. "所有 X 都要 Y"类任务：列全量清单逐项打勾，禁止改两个样例就报完成
3. 含中文的文件：UTF-8 无 BOM，并扫非预期字符集（西里尔/假名形近混入：`rg '[\x{0400}-\x{04FF}\x{3040}-\x{30FF}]' <file>`）
4. 本轮临时文件/测试产物当场清；新旧实现不共存
5. 任何凭据/token 不进日志、命令行参数、汇报正文
6. 之前修好的东西没被这次改动弄回退

## 收尾三件套

活收完必报：是否 commit、是否 push、验证怎么跑的（命令 + 结果）。测试期产生的临时文件当场清。
