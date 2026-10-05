# Full Growth：一次有证据的修正与新封存评测

2026-10-05（Asia/Taipei）。修正阶段接线的工程验收通过，完整成长仍 INCOMPLETE；本轮付费供应商请求 0。Goal 保持 active。原 Pilot01 不重跑、历史 unknown 不结算、单次 probe 授权不复用；没有新 T0/T1，没有合并、部署或后台学习。

## 实际修复及影响调用链

原 host.review 对整个 journal 只允许一次 review-reserved。这能阻止重考，却也阻断用户方案中的“真实开发失败 → reopen → 新方法 → 新封存评测”。此轮复用原 HerGrowthHost/loop/journal/BgTask/模型用量/独立 assessImprovement 门禁，仅让新计划可选冻结 correction.developmentTaskIds 和 correction.review。两套 heldout/regression、开发题与最终题的 ID 和输入摘要一并验证、深冻结；第二套阈值不能低于第一套。旧冻结计划未被改写。

独立评测代码移入 review.ts，host.review 仍通过原执行器与付费账本调用，不建立新预算或清空 spent。第二套只允许一次，必须同时有：第一套实际 eligible 回执、原方法被暂停并保留、方法内容确实改变、批准开发任务的真实失败 use-result、同 runId 的执行意图/成功 evaluator .done/.log、原始失败内容及证据进入新经历、修正版引用失败证据。执行文件的 SHA256 再核对；无关新经历、仅换 methodId、篡改材料及第三次 review 均拒绝。它是研究门禁，不构成生产采纳权限。

影响调用方：正式 CLI step → loop.advance → host.review；CLI/use 与 loop.tryMethod 的 select → host.reason；探针授权 host.authorizeProbe；baseline/use/review 的 host.solve。所有请求继续使用同一 inquiry 的预留、实际 usage、累计 tokens/USD/requests、STOP 和时窗，失败不自动重试。

最终任务的 A baseline 预留，或 B selection 在付费调用前留下 task-selection-reserved，都会永久禁止 discover/investigate 与新 review；选择未形成 trial 也不会漏记曝光。新计划同一任务 selection 只允许一次。两套 review 输入（含批次）都无法获准为训练 probe；不把最终四题结果回灌研究。需要修正时先使用预注册开发证据，不能调完再考同一轮。

host.solve 现在要求实际回复为 JSON 对象：null/数组/布尔值已记录的真实用量继续留存，随后失败，不启动 evaluator。新实验草案的 evaluator 另外要求任务答案恰好为一项布尔字段，错答案保持错误，不再以环境真值替代 null。旧 observer 与失败事实保持原样。

## 已核实证据与命令

- 新增 17 项明确标注的工程夹具，使用真实 journal、重启、文件和 BgTask 子进程。FakeModel/方法是预设测试材料，不能证明 Samantha 学习或主动边界判断。
- `node --import tsx --test packages/her/test/growth-correction-host.test.ts packages/her/test/growth-applicability.test.ts packages/her/test/growth-probe-contract.test.ts packages/her/test/growth-probe-host.test.ts packages/her/test/growth-host.test.ts packages/her/test/growth-experiment.test.ts packages/her/test/growth-model-probe.test.ts packages/her/test/growth-completion-policy.test.ts packages/her/test/model-response-boundary.test.ts packages/her/test/model-connect-timeout.test.ts`：exit0，199 pass / 0 fail / 0 skip。[完整输出](correction-evidence/regression.log)。其中跨重启的 v1 review + 开发失败 + v2 review 共10个模型夹具回执，预算从原 journal 累计，不是10次真实供应商实验。
- `npm run check`：exit0，Biome、依赖/入口/锁、tsgo、browser-smoke 完整跑完。[完整输出](correction-evidence/npm-check.log)。仅当前命令 RAYON_NUM_THREADS=1，结束恢复。5条原有 useTemplate infos 保留，新增诊断0；没有改动范围外代码。
- 最初 RED 13项失败，包括缺少新接线以及评分边界；[原输出](correction-evidence/red.log)。第一版接线曾因导入插入点不匹配全部13项失败，原日志保留在 work/growth-complete-goal/correction-initial.log，不包装成13个生产漏洞。首轮全仓 check exit2：新代码的 t.observation 空值类型错误，修正后复跑通过；[原检查](correction-evidence/npm-check-initial.log)。
- 三个代码/测试文件均 UTF-8 无 BOM、<=1000行，见 [源码摘要](correction-evidence/source-manifest.json)。本轮原13文件 SHA256 再核对全一致，见 [历史复核](correction-evidence/historical-after.json)。没有删除失败/预留、伪造 model-result 或清零旧费用。

## 完整 Goal 的实际状态

上一轮在 work/growth-complete-goal/package 形成尚未授权、未冻结的独立草案：同原模型/端点，提案最多 USD1/100000tokens/32requests/30min，8192输出/requireComplete。9个互异的开发/review/四类新任务已实际跑 Git/文件预检；错误答案保持错误、null被拒，fact检查 met/unmet/unknown 都有独立事实。该预检也是工程准备，不是模型成长。它尚未进入 live store 或创建新的 journal。

此轮工程解除“修正版只能重用旧 review”的阻断。未完成：普通任务入口的自动方法检索、新 runner 的连续执行及完整公平预算记录、新独立付费授权和真实 T0/T1、Samantha 自主实验与方法、真实四题A/B、实际迁移/调整/边界/修正及收益。不得用本报告标 P1/P2 PASS；尚无生产 adoption/rollback 或 Samantha JUDGE。

实际 Her BACKLOG 将在同轮回填此项工程进展及未验项。pi 以 a2d72123d94289d53d7336289f0d6102b0b2b25e 为本轮基点，沿用独立任务分支；源码真实提交/远端 SHA 与正常 hooks 回执见 Her 台账 PI-CORRECTION-COMMIT.txt。本报告没有扩大原合并或付费授权。
