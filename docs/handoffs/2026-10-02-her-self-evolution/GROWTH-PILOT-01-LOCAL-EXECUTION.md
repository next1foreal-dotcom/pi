# Growth Pilot 01 — 本地执行回执

结果：**INCOMPLETE，未形成方法**。Samantha 提出了问题与一次自选实验，但提出的 operationId 不在冻结白名单中，宿主拒绝执行。没有实际学习实验观察、候选方法或收益；没有继续门禁、反思或四题对照，也没有重试、补写解法或重跑连通探针。宿主拦截不是模型主动判断正确。

## 授权、关联与窗口

- 读取交接 `26042449fe0d7039c87753cac04fc78f42be4d9c` 的 GROWTH-PILOT-01.md。沿用 pi 独立分支 codex/her-self-evolution-integration-20261002，基点 `2e7ab56347d03a6fe43a31465b737b1ca30bb8a7`；Her 台账分支 codex/her-self-evolution-ledger-20261002，基点 `3ed1b8a18bbe67b761e5a1f76316b089adc53bc2`。本报告与 pi 接线同提交，最终真实 SHA 见配套 Her 台账及交付回复。
- 新 scope/inquiry `growth-pilot-01`，在原 memoryRoot 建独立 journal，未换目录规避保护。授权关联原 windows-reader-inquiry、planDigest `02a1b25d…`、旧 run `e9e181c7-b228-4feb-929f-6e54da270947`、原 reservation/human risk acceptance、成功 model-ready 回执。完整绑定见 live/authorization.json 和 live/plan.json。
- 本机 T0 **2026-10-02T01:15:59.7572596-07:00**；T1 **2026-10-02T01:45:59.7572596-07:00**，America/Phoenix。工程准备与回归完成后、首次付费前冻结；没有续期或重置。首次请求预留 08:16:00Z，最后模型结果 08:16:36Z；08:23:41Z 持久追加 pilot-stop。
- 新额度 US$1 / 100000 tokens / 32 次供应商请求 / 30 分钟，包含各阶段。保留配置模型 `deepseek-v4-flash` 与端点 api.deepseek.com，真实返回身份 `deepseek-flash`。输出 8192、requireComplete=true，所有本轮请求 singleRequest=true，不自动重试或跟随重定向。
- [DeepSeek 官方模型及价格文档](https://api-docs.deepseek.com/quick_start/pricing/) 当轮确认支持该输出上限及旧模型别名；冻结输入 $0.3、输出 $1.2 / 百万 tokens 作为保守上限估算。供应商 usage 是真实回执；美元是冻结价格估算，**没有供应商账单证明，不能称为实际扣款或结算**。
- 旧失败 tokens/USD 仍 **unknown**，原预留 6877 tokens / $0.0082524 不是账单，旧单次 probe 的 146 tokens / $0.0001131 单列。原 journal SHA256 `5295b5196b568e8e3cae692847ee63ae0bbeab6e9e0bd4e8de803874e9c4a5c8` 与 plan SHA256 `4367cb00ad1fa8b14fdc3cf3926e3e7b08306b44bb174b2c803920e4cdc11191` 当轮字节核验未变；没有补造旧 model-result。

## 她提出的问题、实验与方法

输入来自历史真实失败，不是新的用户事故：提交后的干净候选在只读检查中被拒绝，原始 Error 行为 `candidate has uncommitted tracked changes`，实际 1 test / 0 pass / 1 fail。仅提取原始计数及 Error 行，另给原目标；排除揭示已知根因的测试标题、实现栈路径和已知修复。原始来源与实际学习输入分别保存、哈希。工具目录公开可观察的参数，确实提供了 Git/换行配置方向，因此不能声称毫无提示的发现。

Samantha 的问题原文：

> The read-only revision check failed because the candidate had uncommitted tracked changes. It is unresolved whether this is caused by Windows Git line-ending normalization/reader configuration during checkout or read, or whether the candidate was already dirty before the check.

她提出三个竞争假设：CRLF/读取配置导致 dirty；候选本来就被修改；attributes/config 交互不一致。完整问题、wakeWhen、假设和预测均见 live/model-receipts.json 的原始正文。

自选实验拟比较四种 Git 条件：true/inherit/CRLF、false/inherit/CRLF、true/sanitized/CRLF、true/inherit/LF。该批次是一个实验提案，并非四次供应商请求。她为三个假设给出不同预测，没有执行工具。

实际 action 的 operationId 为 `git-status`；冻结操作名只有 `observe-environment`，`git-status` 只是 input.kind。四个 cases 还遗漏了 kind。宿主在批准前拒绝，第一个问题是未授权 operationId；缺 kind 是对原始提案的静态诊断，**没有修正或执行后的证明**。状态 deferred/revision4，thoughts2/probes0。没有执行成功/失败观察回执，没有形成原始方法；method 不存在，不用实施者的方法替代。

## 四题对照（预注册 8 行，全部缺失）

新任务和独立门禁在形成方法之前封存。真实 Git/文件预检只证明构造题的环境答案，不是 Samantha 的实验结果，也不是自主学习或用户收益。review minGain 沿用 0.5，没有降低；没有候选，因此门禁未消费。

| 题目 | 组 | 状态/通过 | 检索、选择、复用、迁移、调整或边界判断 | 实际请求 | tokens / USD / 时间 |
|---|---|---|---|---:|---|
| T1 新 Git 内容，同设置读取 | A | 缺失 / 未评测 | 没有候选，未进入对照 | 0 | N/A |
| T1 新 Git 内容，同设置读取 | B | 缺失 / 未评测 | 同上 | 0 | N/A |
| T2 Git 表象→两文件 literal 比较 | A | 缺失 / 未评测 | 同上 | 0 | N/A |
| T2 Git 表象→两文件 literal 比较 | B | 缺失 / 未评测 | 同上 | 0 | N/A |
| T3 比较规则改为 case-insensitive | A | 缺失 / 未评测 | 同上 | 0 | N/A |
| T3 比较规则改为 case-insensitive | B | 缺失 / 未评测 | 同上 | 0 | N/A |
| T4 opaque binary 精确比较 | A | 缺失 / 未评测 | 同上 | 0 | N/A |
| T4 opaque binary 精确比较 | B | 缺失 / 未评测 | 同上 | 0 | N/A |

计划顺序 T1A/B、T2B/A、T3B/A、T4A/B，每组每题最多两次模型调用，同输出设置。A 的两次预算可用于自行选方案与完成题，B 用于方法选择与完成题；两组共用原始经历、探针观察和一次同源反思。本轮没有生成反思或任何对照答卷，不能声称实际进行了匹配评测。原有 recallGrowthMethods + tryMethod 是受控方法使用入口，不冒称完整自主检索；本轮完全没有调用。自然语言前提不再靠旧关键词判真，无法证明时返回 unknown 并由宿主阻断，不能计为模型主动拒用。T4 的适用性也未判定，不事后强制改为禁用题。

## 全部真实调用与失败记录

| 阶段 | responseId | 实际模型 / 结束 | 输入 | 输出（含供应商计费推理） | 合计 | 冻结价格估算 USD |
|---|---|---|---:|---:|---:|---:|
| discover | 16673bb0-429c-4d78-951a-bacf0fc184e3 | deepseek-flash / stop | 570 | 1439 | 2009 | 0.0018978 |
| investigate | 26e8f22b-0b95-43d0-8303-e37dd0e0c51e | deepseek-flash / stop | 976 | 6434 | 7410 | 0.0080136 |
| **本轮合计** | **2 次，HTTP200** | **新未知用量 0** | **1546** | **7873** | **9419** | **0.0099114** |

学习/反思/评测/对照/选择/使用均由同一宿主计费路径计数。除上表两次学习决策调用，其他阶段实际请求均为 0。有效正文、完整 prompt、usage、runId、模型身份与 finishReason 均保存在 live/journal.md、live/model-receipts.json 及两行 live/audit-pilot.jsonl；隐藏推理文本与凭据未发布。

失败一：本地构造题首次预检使用 .NET 默认管道编码，中文损坏，结果被拒绝。付费前改显式 UTF-8 重做并封存实际结果；原失败文件留在原 evals/pilot01/preflight-encoding-failed.json，inventory 说明该失败，未把它用作真值或模型经历。

失败二：模型提案混淆 operationId 与 input.kind，宿主拒绝。没有自动修复请求、替她改 action、再次执行或重新开窗。已追加不可恢复的本轮 pilot-stop；有余额也不能通过重开 host 恢复请求。没有收益或成功结论。

## 接线与工程验证

仅改现有 host.ts 与 growth-host.test.ts，复用 journal/CAS、模型、任务执行器和独立评审。新增持久请求总数上限、所有 capped 方案 singleRequest、已知供应商失败与 pilot-stop 关闭、批次开发输入排除封存题、共享经历/观察/反思、选择时真实任务输入以及受控对照入口。学习运行后只补 pilot-stop 的持久阻断与回归；没有改原学习提示、计划、模型、操作或窗口。执行时源码哈希与最终验收源码哈希分别保存。

- `node --import tsx --test packages/her/test/growth-host.test.ts packages/her/test/growth-experiment.test.ts packages/her/test/growth-model-probe.test.ts packages/her/test/growth-completion-policy.test.ts`：exit 0，**91/91，0 fail/skip**。预设回复只用于工程验证。
- `npm run check`（本次进程 RAYON_NUM_THREADS=1，结束恢复）：exit 0，1825 文件；5 条原有范围外 infos 未改，无新增错误。完整日志见 check.txt。
- 原历史宽回归两项时间夹具失败已有干净基线复现，本轮没有重跑全套测试，也未宣称整个测试库全绿。
- 旧 journal/plan 字节、2 reserves 对 2 results 与 2 audit、0 unknown/执行、UTF-8、密钥及实际 staged 内容另行核验；见 verification.json、artifact-manifest.json 与发布扫描。
- 未改 upstream、Python、权限范围、SOUL/人设、生产记忆、后台定时器或部署。无依赖新增，无合并、无部署、无真实技能提升声明。

**未验项**：实验执行与观察、原始方法、独立候选门禁、四题八行实际对照、正常自主检索、迁移/调整/边界主动判断、完整四步收益、供应商美元账单、生产采纳/观察/回滚及 Samantha JUDGE。保留失败及分母，先导按真实结果结束，不自动启动第二场。
发布说明：check.txt 仅规范换行及行尾空白，原始日志留在任务私有 work/，两版 SHA 见 log-normalization.json。live 下的实际 journal、正文、用量和封存输入按原始字节保存。
