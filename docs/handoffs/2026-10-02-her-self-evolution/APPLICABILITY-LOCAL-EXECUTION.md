# Applicability：事实合同与真实宿主验收

2026-10-04（Asia/Taipei）。本轮可观察前提接线 PASS；完整成长仍 INCOMPLETE。供应商请求 0，不进入 P2、不重放 Pilot 01、不复用单次 probe 授权、不重开过期窗口。旧未知费用与原预算/失败/停止记录保留；未合并部署。

## 根因与改动

原 Pilot observer 对自然语言前提没有可信的解释器，真实返回 unknown。工具协议只解决输入形状，不能据此放行方法。这里在已接入的 HerGrowthHost 中新增可选 applicabilityFacts，声明经宿主批准的有限标量事实类型；与整份计划及 operation 源码 SHA256 一同冻结。方法仍由模型提出，宿主不会将自然语言猜成通过，也不会给模型预写方法或 scope 值。

新的方法前提字符串使用精确 JSON 语法 `{"fact":"approved.fact.name","oneOf":["model-selected-value"]}`。每项只能有这两个字段，值必须与冻结类型相符；全项独立观测匹配才 met，已知不匹配为 unmet，缺失、不支持、类型错误、自然语言或空前提均 unknown。unknown 优先于不匹配。该合同核验事实条件，不证明方法质量、根因正确或语义范围完整。

新增独立 observe-applicability.mjs，作为新计划可选的 applicability operation；使用真实隔离文件与 Windows Git 查询事实，不调用模型、不读预期答案、不返回 equal/dirty。支持 text-pair、text-view、binary-pair、git-status。Git 二进制只能来自操作方冻结的任务输入，使用绝对路径；Git 配置查询的 inherit 与 sanitized 明确隔离，后者显式 core.autocrlf=false，不宣称代表机器全局配置。工具选择仍由既有权限/计划控制，不是 OS 沙箱。

applicability-result 将 met/unmet/unknown、问题路径、method/task/plan/facts 摘要及 runId、真实 .done/.log 证据引用追加到原 Markdown journal。新合同下 authorizeUse 与 runUse 都要求最新匹配的 met 回执，关联批准 operation 的 execution-intent 与成功 execution-result；换方法版本、换任务、后续 unknown、回执写入失败均阻断。runUse 在 consume 及模型求解前复核。持久 pilot-stop 现在也拦截无付费的观察/工具动作。

影响调用方：正式 CLI step/try → loop.advance/tryMethod → host.reason/checkApplicability/authorizeUse/runUse → 原 journal/grant/consume/BgTask 执行器。既有 review、模型适配器、预算和 STOP 链复用。旧冻结计划未声明 applicabilityFacts 时保留旧 evaluator 接口；原 Pilot 的 unknown 分支、失败及停止保持原样。没有自动修改已冻结计划以切换 collector。

## 工程观察与结果

| 观察或故障 | 实际结果 |
| --- | --- |
| UTF-8 文本、指定 normalize-lf 规则 | 真实写读文件后 met，证据 SHA256 与 .done/.log 一致，无模型调用 |
| 改为 literal 或二进制输入 | 分别观测规则/编码变化，unmet；模型夹具仍选择 use，被宿主拦截，不能记作主动边界判断 |
| 自然语言、缺少 Git 事实、错类型或未批准事实 | unknown；不会默认为真 |
| Windows Git readerConfig | 实际 config 查询：inherit 的 autocrlf=true，sanitized=false，真实 Git version 与 CRLF；不透露 dirty 答案 |
| 没有检查、换任务、换方法或后续 unknown | 不授权或不 consume、不启动模型求解 |
| 真实 collector 成功但回执 append 故障 | 向上抛错；保留 execution-result，但无用法授权 |
| evaluator 只输出 met=true | 无独立 facts，unknown；恒真不构成事实凭证 |
| STOP/pilot-stop | 执行意图及进程/模型调用之前拒绝 |
| 正向接线到真实 use | 原工具子进程实际执行；FakeModel 错答案仍 failure/suspended，绝不计学习成功 |

全部方法、输入及 FakeModel selection/solve 是手写工程夹具。不是 Samantha 自主提问、实验、反思、方法、迁移、修正或收益证据。真实文件/Git 子进程证明接线与双侧门禁行为，不替代付费成长先导。

## 命令与失败记录

完整工程：D:/@Her/wt-self-evolution-20261002，原独立分支 codex/her-self-evolution-integration-20261002，基点 793c5d26a0113c71a7ba8df94310f92409845b23。交接分支 fetch exit0，仍是指定 2aa912401ce69b8157c16c12c422cfd94dfb7f72；未重复叠加 provider/probe 补丁。

- `node --import tsx --test packages/her/test/growth-applicability.test.ts packages/her/test/growth-probe-contract.test.ts packages/her/test/growth-probe-host.test.ts packages/her/test/growth-host.test.ts packages/her/test/growth-experiment.test.ts packages/her/test/growth-model-probe.test.ts packages/her/test/growth-completion-policy.test.ts packages/her/test/model-response-boundary.test.ts packages/her/test/model-connect-timeout.test.ts` — exit0，182 pass / 0 fail / 0 skip，见 [完整回归](applicability-evidence/regression.log)。包含真实 CLI/loopback、执行器、未知用量、单次请求限制、封存输入与独立门禁；没有付费网络。
- `npm run check` — exit0，包含全仓 Biome、依赖/入口/锁文件、tsgo 与 browser-smoke，见 [完整检查](applicability-evidence/npm-check.log)。仅本进程设置 RAYON_NUM_THREADS=1，结束恢复；5 条已有 useTemplate infos（memory.ts 三条、jsx-attr.ts 一条、her-core-modules.test.ts 一条）保留，没有新增诊断，没有顺手改无关代码。
- `node --check packages/her/src/growth-experiment/observe-applicability.mjs` 与 `git diff --check` — exit0。4 个源码/测试文件均 UTF-8 无 BOM、<=1000 行，SHA256 见 source-manifest.json。

保留失败：初期 RED 为4失败，其中包含新端口尚未接入及 public task 夹具形状问题，不将其包装成4个生产漏洞；修正夹具后新套件12/12。受影响回归首次181/182，新增任务绑定不应改变旧计划的环境负例，限定到新合同后182/182。首次 check exit2：目标库无 findLast，以及负例测试强制转换不符合类型检查；改为不修改原数组的 reverse/find 与明确 unknown 强转后完整检查通过。[原回归失败](applicability-evidence/regression-initial.log)、[原检查失败](applicability-evidence/npm-check-initial.log)、[初期RED](applicability-evidence/red.log)均保留。仓内日志仅去除行末空白/文件末空行，完整原始日志在 work/applicability/。

## 历史、台账及未验边界

13 个历史文件前后 SHA256 全部一致，见 historical-before.json / historical-after.json，包括原 Pilot 授权/计划/输入/回复/失败/停止及两个 journal 和旧计划。Pilot 01 仍2请求/9419 tokens/$0.0099114冻结单价估算（不是供应商账单），探针执行0、方法0、门禁及四题对照未跑；旧失败 actual tokens/USD 仍 unknown，预留不作账单，没有补造 model-result 或清账。

适用性工程阻断对可观察事实已解除；自然语言前提仍诚实 unknown。未来新授权计划必须明确选择并冻结本 collector 与事实目录，模型自主提出适用条件；不能把旧失败 action 自动修成成功，不能转写/复用旧停止窗口。没有创建或冻结新的付费实验窗口。

整体计划状态：发现已有真实问题/三假设；学习只有被拒绝的提案，没有真实实验观察或方法；迁移与修正未开始。模型会不会正确使用新合同、能否形成方法、独立门禁是否通过、四类任务及对照是否有收益、模型主动边界判断、生产 adoption refs/回滚和 Samantha JUDGE 均未验。

实际 Her BACKLOG 的快照与 G-280/G-281 同轮新增工程结果，不更改历史 DONE 的范围或宣称成长完成。源码提交后真实 SHA、正常 hooks 与 live ls-remote 记录在 Her 台账副本 PI-APPLICABILITY-COMMIT.txt；无自动合并部署，未注册调度或新增依赖。
