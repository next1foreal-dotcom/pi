# 完整成长：新独立实验授权与正式启动入口

2026-10-05，Asia/Taipei。接线工程通过，完整成长仍 INCOMPLETE / Goal active。本轮新增真实供应商请求 0，新批准、T0/T1、live Pilot02 均未创建；未合并或部署。此前 TASK-RUNNER-LOCAL-EXECUTION.md 所列授权与付费启动器欠账由本增量接入，真实自主学习和四题对照尚待执行。

影响调用方：HerGrowthHost.open/assertRunning/completeWithReceipt、正式 CLI、continuous runner 初始经历，以及 task/review/observer 共用的原预算和 journal 锁。没有新框架、备用模型或生产调度。

## 可核对行为

正式 `her growth pilot <memoryRoot> <frozen-plan>` 读取获准原始经历，thoughts12/probes2，进入既有连续 runner。只允许 pilot/status/recall；禁止逐步付费手动重放、额外 probe、替换输入或重复初始化。每次付费调用须先取得连续运行 reservation，原预留/实际回执/请求数/STOP/时窗/日费用上限继续生效。新失败、未知用量、停止或崩溃不自动重试；只读 status 仍可查停止记录。

新 owner 授权绑定完整 proposal 摘要、同一 memoryRoot、当前完整 endpoint/模型、具体原始经历 SHA、独立旧失败风险决策、已停止 Pilot01 与已有 model-ready/真实回执。源文本只接受新 direct-user-message，必须引用实际人工同意；本地人工记录是来源声明，不是密码学身份认证。旧单次探针授权不能代替，未批准 draft 会被拒绝。

在每个操作和原 root 锁内的每个新请求前审计同目录全部 journals。仅旧 windows-reader-inquiry 的具体 unknown run 被原风险决定豁免；其他新/跨 inquiry 的未知、缺账、重复/损坏记录、并发外部费用、同一批准复用、伪零结算均阻断。旧日志不修改，旧预留不当账单。原始经历对象与冻结文件精确核对，不能换成教师预写根因。

新预算最多 US$1 /100000 tokens /32 次请求 /30 分钟，所有研究、评测、反思、选择、控制、使用与修正共享累计预算。输出8192、requireComplete=true，两组相同。实际模型返回 tokens 是用量；USD 使用冻结价格估算，不冒称供应商账单。原历史已知小计9565 tokens /US$0.0100245 estimated（其中 probe146/Pilot01 9419），总量及总费仍 unknown。

独立包 [冻结草案](pilot-authorization-evidence/prepared-plan.json) 与 [授权关联提案](pilot-authorization-evidence/approval-proposal.json)，proposalDigest `8bb503be40e0ef891bf71eb8326820c05568a542737a6f4e85da8f8b65dafec5`。四题分别为 Git LF 配置、混合文本视图、大小写与换行混合、同长度不同二进制；独立开发题、两套门禁输入互异。期望只进入封存评分器；初始模型只看原始经历，不看根因、方法或门禁期望。全部9项真实文件/Git预检输入仍匹配，13历史文件哈希未变。

[供应商模型/价格文档](https://api-docs.deepseek.com/quick_start/pricing/) 当日核对：原配置 legacy deepseek-v4-flash 仍接受并由 V4.1 Flash 服务；冻结保守高峰 input0.3/output1.2 USD/M，不改配置。[接口文档](https://api-docs.deepseek.com/api/create-chat-completion/) 支持8192 max_tokens。复用既有真实 model-ready，不新增连通探针。

## 本机一次性启动准备

具体可审查文件在 `D:/@Her/wt-self-evolution-20261002/work/growth-complete-goal/`：freeze-pilot.ps1、validate-staged-approval.ts、prepare-authorization.ts、verify-prepared.ts 及 package；[哈希清单](pilot-authorization-evidence/packet-manifest.json)。这些是本机执行包，未批准，不是已发生的实验或供他机原样启动的发行包。

收到新的实际人工批准后，单独追加 owner-approval.json，包含批准原文、引用、时间、proposalDigest 与三条历史关联，不伪造或复用旧同意。freeze-pilot.ps1 在同一 live root 新建 evals/pilot02，先核对 source proof/操作/历史/授权，不发付费请求。校验用时戳仅在内存，未写执行窗口；准备完成后一次取本机 DateTimeOffset.Now，记录带时区 T0、T1=T0+30m，以 CreateNew 保存正式 plan。已有目录或窗口拒绝覆盖/续期，失败保留现场。

冻结后从已核验工程只执行一次：
`node --import tsx packages/her/src/growth-experiment/cli.ts pilot D:/@Her/tmp/growth-live-20261002 evals/pilot02/plan.json`

连续研究/原独立门禁/真实开发失败才 reopen/公平四题八行与缺测及终止语义沿用 TASK-RUNNER-LOCAL-EXECUTION.md。无方法、拒评、无收益可是真实结论；工程 fixture、协议通过和 host-blocked 均不算 Samantha 自主学习成功。

## 验证、失败与欠账

[RED](pilot-authorization-evidence/red.log) 复现旧 host 漏检其他 inquiry 未知费用。13个受影响 test 文件249/249 pass，0 fail/skip，包含实际正式 Her CLI 子进程与 loopback HTTP、旧记录不结算、冻结时窗不可重置、未知立即停/防重放；[完整回归](pilot-authorization-evidence/regression.log)。这些全部是离线工程协议证据。

完整 `npm run check` exit0，[日志](pilot-authorization-evidence/npm-check.log)；5条既有 useTemplate infos、新增诊断0。首次 check 因新测试对只读 plan 修改产生 TS2540，已用可变副本修正，保留 [原失败](pilot-authorization-evidence/initial-type-failure.log)。RAYON_NUM_THREADS=1 仅命令期间设置并恢复，无依赖/全局配置改动。

[源文件行数/无BOM/SHA](pilot-authorization-evidence/source-manifest.json)，各<=1000；[准备检查](pilot-authorization-evidence/prepared-check.log) 的 b188/69049 是旧准备基点，不是本轮提交 SHA；[冻结脚本语法及未批准拒绝](pilot-authorization-evidence/freeze-check.log) 确认 live pilot02 不存在。[原历史只读记录](pilot-authorization-evidence/history-readonly.log) 保留实际关联。实际提交与实时远端证明在 Her 台账 PI-PILOT-AUTHORIZATION-COMMIT.txt。

未验证：新付费窗口/实际启动、真实自主问题与两次实验、形成原始方法、四题配对收益、迁移/调整/真实修正与模型主动边界判断；未给 P1/P2/JUDGE/生产成功。用户明确禁止自动重跑或续期，Goal 不取消该约束，执行包完成后须一次新独立付费授权。