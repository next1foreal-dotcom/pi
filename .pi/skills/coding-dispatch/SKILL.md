---
name: coding-dispatch
description: 写码任务的派工纪律：怎么把实现/计划/复审正确派给 .pi/agents/ 的 project 班子，而不是自己写。触发：Fei 或驱动方要求实现功能、修 bug、写测试、出实施计划、复审代码，或点名"派给 coder/planner/班子"；以及外部 CLI、派给 grok、通道水位。单文件小改（<20 行、无架构含义）直接做，不套派工。大活的拆解与并行编排看 orchestrate——本 skill 只管 subagent 这把枪怎么打准。
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

**并行改同一个仓的任务，`her_task_spawn` 带 `isolation:"worktree"`**——每个任务在自己的 git worktree（分支 `her-task/<taskId>`）里跑，互不踩工作树；跑完没产出就自动回收，有 commit 或有未提交改动就保留，路径和分支写进汇报等你验收合流（不自动合并）。

## 外部 CLI 通道(G-354)

班子岗位是 API 型脑；外部 CLI（grok / cursor-agent / codex）是订阅型算力。两层并存，不互相替代。实现 / 修 bug / 写测试类的大活，优先走外部 CLI。

**怎么派。** `her_task_spawn` 带 `worker:"grok_build"` + `isolation:"worktree"` + 按活点名 `gates`。任务书必须自包含：绝对路径、验收命令、失败出口。六要素模板见同目录 `references/taskpkg-template.md`。

推荐档案（只进她的 config，本仓库不改活 config）：

```yaml
workers:
  grok_build:
    argv: ["grok", "--always-approve", "--output-format", "plain"]
```

`--always-approve`：grok 的 Windows 沙箱是静默空操作，隔离靠 worktree，门禁靠 G-206；工具审批弹窗在无头下会挂死任务。brief 走 `--prompt-file <id>.brief`（管线注入，答案走 stdout / 任务日志）。

**探针前置。** 探针已是 spawn 层**门禁**(G-356):没有 ≤24h 的 `ops/channel-probe-latest.json` 或该通道 dead,`her_task_spawn` 会拒绝;补救=跑 `node packages/her/scripts/probe-worker-channels.mjs --write-latest`。**探针绿≠有额度**照旧。

**水位快照（2026-08-31）：** grok 主力；cursor-agent / codex 额度尽，恢复以 Fei 口径为准；claude CLI 凭据失效待重登（医治=Fei 跑 claude login，一针连治 claude-bridge 与 claude worker）。

名册表以 `.pi/agents/*.md` frontmatter 的 `model` 为准（本轮已核，8 行一致）。对不上又查不到的行标「待核」，禁止凭空发明型号。

## 承重假设先实弹(G-356)

任务包写下之前,把设计压在上面的那一两个假设**先用最小实弹钉死**——一发探针省一轮返工。
判据:哪个假设错了会推翻整包设计,哪个就值得一发实弹;其余假设交给执行方在包内核实。
实弹结论写进任务包「已实测钉死的事实」一节,注明日期与证据;执行方以此为准,不复测浪费额度。
例(G-354):grok 吃不吃 stdin 决定整个注入设计——三发探针(`-p` 缺参报错 / `-p -` 把 `-` 当字面提示词发给了模型 / `--prompt-file` 独立可用)当场定案,任务包因此一次成活。

## 验收纪律（收货不收话）

**先分清两条派工路，它们的验收机制不是同一个：**

- **`subagent` 工具派 `.pi/agents/` 班子** → 验收合同由 `pi-subagents` 包实现（Fei 的 preset 装的）。它会往子代理的 prompt 里自动追加 `## Acceptance Contract`，要求结尾给一个 fenced `acceptance-report` JSON 块；分 `attested/checked/verified/reviewed` 几档，`verified` 档运行时自己跑校验命令，`reviewed` 档必须有独立复审结果。**这条路的合同一直是真的，不是我做的。**
- **`her_task_spawn` 派后台任务** → 2026-08-03 之前**没有任何验收**：worker 退出 0 就是 `completed`，没人跑门禁、没人查证据。**这条路现在补上了机器闸（G-206），下面说的是它。**

- **门禁自动跑。** `her_task_spawn` 带 `isolation:"worktree"` 的任务，worker 退出 0 之后，**Her 自己**在那个 worktree 里跑一组门禁命令（本仓默认见 `.pi/her-gates.json`），记下每条的 exit code + 输出摘要 + 全文日志路径。
  - 全绿 → 任务才是 `completed`，记录里带 `acceptance.verdict: green`。
  - 任何一条红/崩了/没跑成 → 任务是 **`failed` + `failureReason: acceptance_rejected`**，`acceptance.verdict: rejected-needs-evidence`。**这不是我判的，是退出码判的。**
  - 没门禁可跑 → `unverified`。**`unverified` 不等于绿**，它的意思是"没人查过"。
- **派工时可以点名门禁。** 任务动的东西默认门禁盖不住，就在 `her_task_spawn` 传 `gates: [{name, command}]`（argv 数组，argv[0] 必须是 node 或已配置 worker）。传了就整套替换默认。
- **执行方的自述报告只在有证据时才算数。** worker 可以在自己 worktree 根目录写 `.her-acceptance-report.json`：`{"claims":[{"claim":"...","command":[...],"exitCode":0,"outputDigest":"sha256:..."}]}`。每条 claim 必须三样齐全，且 command/exitCode/digest 要跟 Her 自己那次测量对得上——**光有话没有证据 = 拒收；数字对不上 = 拒收**（digest 是 Her 跑的时候自己算的，伪造不了）。没写报告不扣分：门禁绿本身就是证据。
- **绿了也不自动合并。** 通知里带 worktree 路径 + 分支 + `diff --stat`，合不合是人（或上层会话）的动作，管线不碰。
- 门禁绿 ≠ 全仓绿：唤醒消息里会列出**具体跑了哪几个门禁**，看那一行，别把 `green` 读成"全都过了"。
- commit 信息写清：派给了谁、验收证据是什么。
- **判断半边。** 任务完成后跑 `her accept <taskId>` 拿判词草稿。拍板纪律见 acceptance-officer 技能；草稿不是免检章。

## 卡壳升档（同方向失败两次就换脑，不许第三次微调）

血泪规则「同一 bug 第二次复发禁止同方向微调，必须先给出根因分析」的路由版：那条讲**怎么想**，这条讲**换谁来想**。

**触发**：同一个子任务、同一个方向连续失败 2 次——同一族报错、同一处改不动、验收报告同一条不过。第 2 次失败当场停手，不许开第 3 次微调。

**先分因，再决定升不升**（升错了只是烧钱，不解题）：

- **脑力不够**（读不懂上下文、根因找不到、方案一直差一口气）→ 升档重派，梯子在下面。
- **环境/凭据/额度**（额度墙、key 缺、超时、沙箱挡、工具不通）→ **升档没用，换多贵的脑都撞同一堵墙**。按下面的诚实纪律原样转述错误给 Fei，别拿贵脑去撞。

**升档梯子**（只在"脑力不够"时爬）：

| 现在是谁 | 升到哪 | 备注 |
|---|---|---|
| `explorer` / `deep-reader`（deepseek-flash） | `coder`（codex gpt-5.5:high） | 探索档读不动的活，本来就不该在探索档解 |
| `coder`（:high） | `code-reviewer`（codex gpt-5.5:xhigh） | 同一实现路线上再来一遍，但更深 |
| `coder` 两次都跑偏方向 | `planner`（claude-opus-4-8） | 这不是实现问题是路线问题，要的是根因分析和分步计划，不是又一版代码 |
| 「某说法到底真不真」卡住 | `claim-verifier`（deepseek-v4-pro） | 独立核验，别让写的人自证 |

**换脑之前先换题**：升档任务书里必须带上「前两次怎么失败的 + 原样报错 + 已经排除了什么」。把同一份任务书原样丢给更贵的脑 = 花更多钱买同一个失败。

**升档动作要写进汇报**：谁失败了两次、失败长什么样、升到了哪一档、为什么判定是脑力不够。默默换脑 = 账不对。

**上限两档**：爬满两档还不过，停下来问 Fei，不许一路往上烧。

**升档要花真钱**：见下面诚实纪律的额度常识——Codex / Claude 两档都吃与 Fei 桌面共享的订阅，deepseek 岗按量计费很便宜（探索/深读/核验别省，该并发就并发）。所以升档是有代价的决定，不是免费的重试。

> 工作台侧（samantha-ui composer）已经按同一套路由做了**默认档**：Fei 没手选模型时，plan → Claude 高档（判断力活）、code → Codex、design → 保持现默认；他一旦手选，手选永远最高优先，模型 chip 显示的就是真正要跑的那颗脑。默认档管起点，本节管卡住之后往哪走——两边的岗位名册是同一份，别各写各的。

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
