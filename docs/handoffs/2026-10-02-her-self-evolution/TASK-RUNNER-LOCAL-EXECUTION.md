# Full Growth：普通任务检索与连续研究 runner

2026-10-05（Asia/Taipei）。本轮完成接线工程增量，完整成长仍 INCOMPLETE，Goal active。本轮真实供应商请求 0；未开始新的付费窗口、未重跑 Pilot01、未合并或部署。以下工程夹具不是 Samantha 学习成功的证据。

## 行为与真实调用链

旧 `growth use <task-id>` 直接进入受控方法使用。新正式 `her growth task <memoryRoot> <plan> <task-id>` 只接收任务，不点名方法或要求使用：CLI → runGrowthTask → recallGrowthMethods → 当前获准 inquiry 的独立门禁版本 → 原 loop.tryMethod。模型使用或主动拒绝，宿主另做真实前提/权限核验。检索不授予跨 inquiry 的工具权限；暂停版本不能重新激活。这里只是批准研究范围内的普通任务检索，不声称生产 P2 自主成长。

使用成功/失败、model-declined、host-blocked、no-active-method 与 interrupted 分开留痕。选择失败、未知用量、待核对动作不会通过 fallback 再请求。合法主动拒绝或宿主范围拒绝可使用第二个匹配调用独立解题；不把 host-blocked 算作模型判断正确。A=deliberation+solve，B=selection+solve，共同 raw experiences/probe observations/同源反思与相同冻结模型设置。

先复现了 A 已执行后、B 无方法也要 deliberation 的槽位冲突；[RED](task-runner-evidence/red.log) exit1。runBaseline 现在在原 journal 锁内为 control 与 task 各预留一次，不能切 deliberate 值重放；没有第三组、独立预算或备用模型。影响调用方包括原显式 use 的控制脚本、普通 task、review/commonContext 及新 runner；原默认 control 调用不扩权限。

新增 runGrowthPilot 复用原 advance/reopen/host/review/journal，需新冻结 pilot 合同、revision0、thoughts12/probes2、独立开发题、四个最终题及 requireComplete/request cap。旧冻结 Pilot01 没有该合同，不能在 runner 重新启动。尚未开放付费 pilot CLI；全目录历史风险授权关联及启动器仍待接入。

连续顺序：真实发现/最多两次自选 probe → 原独立门禁 → 预注册开发任务 → 仅实际方法失败时用其原始 use-result/执行证据 reopen（保留 spent）→ 新版本/新门禁 → 一次不引用方法的共同反思 → T1 A/B、T2 B/A、T3 B/A、T4 A/B。最终任务入口预留即封闭研究；最终题失败不能回灌方法或再考。方法暂停后后续 B 缺测，A 可以在预算/STOP/用量允许时继续。

报告始终保留八个条件：未执行/缺测的 usage/耗时/输出为 null；中断保留已知小计和 unknown，不把预留当账单。输出 NO-METHOD、REVIEW-REJECTED、INCOMPLETE、NO-OBSERVED-GAIN 或 PROMISING-PILOT；四题单轮不构成正式 P1/P2 PASS、显著性或生产采纳。report 与 pilot-stop 持久化，运行中断的 reservation 也禁止自动重放。

## 核实结果

`node --import tsx --test packages/her/test/growth-task-entry.test.ts packages/her/test/growth-pilot-runner.test.ts packages/her/test/growth-correction-host.test.ts packages/her/test/growth-applicability.test.ts packages/her/test/growth-probe-contract.test.ts packages/her/test/growth-probe-host.test.ts packages/her/test/growth-host.test.ts packages/her/test/growth-experiment.test.ts packages/her/test/growth-model-probe.test.ts packages/her/test/growth-completion-policy.test.ts packages/her/test/model-response-boundary.test.ts packages/her/test/model-connect-timeout.test.ts`：exit0，223 pass/0 fail/0 skip，[完整输出](task-runner-evidence/regression.log)。新增24项协议夹具，实际 journal/子进程/事实/门禁和 loopback CLI，包含无方法/拒绝/拦截、失败暂停、未知用量、崩溃防重放、公平两调用、拒绝评测、无收益、修正新门禁。模拟修正轨迹累计32个模型夹具回执，不是32次真实供应商请求。最初扩展 task 夹具有4项因 use adaptation 数组为空被正确拒绝，修正夹具后通过，原日志保留 work/growth-complete-goal/task-expanded.log；没有放宽解析器。

`npm run check`：exit0，完整 Biome/依赖/入口/锁/tsgo/browser-smoke，[完整输出](task-runner-evidence/npm-check.log)。5条既有 useTemplate infos保留，新增错误/警告/infos 0；RAYON_NUM_THREADS=1 仅命令期间设置并恢复。未运行 build/root npm test/full vitest、未改依赖或全局配置。

[八个源文件 SHA/行数/UTF-8无BOM](task-runner-evidence/source-manifest.json)，各 <=1000 行；完整 check 没改范围外文件。新草案增加冻结 runner 合同，approvedBy仍空、expiresAt/T0/T1仍null、尚未进入live root。原9个真实文件/Git预检输入/observer摘要一致，13个历史文件逐一复核未变：[准备检查](task-runner-evidence/prepared-check.log)。旧失败 unknown、预留、风险决策及真实 probe/Pilot01 停止原样保存。

## 剩余与交付层级

源基点 b1882e132fc0d5100255cc0d832dcb396d33d8b8，独立分支 codex/her-self-evolution-integration-20261002。正常 hooks 提交/推送后实际 SHA/live remote 证明回填 Her 台账 PI-TASK-RUNNER-COMMIT.txt；不合并到运行分支、不部署。实际 Her BACKLOG 同轮更新，工程通过与真实成长欠账分列。

尚未完成：审计同一 live root 的所有 journals、旧特定未知请求例外与新实验明确绑定、冻结一次性授权/T0/T1/价格支持核实、正式付费 runner 启动器及其回归、新独立付费授权、真实自主问题/实验/方法、四题A/B、主动边界、迁移/调整/修正及收益。用户明确禁止自动付费重跑/续期；当前 Goal 不取消该限制。准备完整可核对后仅请求一次新授权，现阶段不发起供应商请求。
