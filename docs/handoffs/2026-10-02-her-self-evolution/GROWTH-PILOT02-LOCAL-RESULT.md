# Growth Pilot02 — 真实执行停止：HTTP402 / 新用量 unknown

2026-10-05（Asia/Taipei）。结果 **INCOMPLETE**，不是 Samantha 学习成功、NO-METHOD 自主 defer、门禁拒绝或收益结论。收到同一会话对 Pilot02 新批准请求的实际人工回复“批准”后，仅执行了这场独立实验。旧 Pilot01 和旧 probe 未重跑。

## 实际批准、窗口与请求

[实际批准记录](pilot02-live-evidence/owner-approval.json) 原文仅“批准”，引用此前完整 Pilot02 请求 call_UhbnWXk1SOJEQg8cWSrfPc31；该本地记录是实际会话来源声明，不是密码学身份认证。冻结关联 proposalDigest `8bb503be40e0ef891bf71eb8326820c05568a542737a6f4e85da8f8b65dafec5`，同一旧 live root、旧具体 unknown 风险决定、旧停止 Pilot01、已有 model-ready 回执。

源实际 SHA `e0f7077b45ec6ae057450b6259c903e57bf1fa05`。准备前19项源码/操作/包/config哈希及13历史文件核对未变，继承同版本249项受影响回归与完整npm run check exit0；没有改源代码或增加回归。冻结脚本先完成全目录用量/授权校验，再一次取本机时间：

- T0 `2026-10-05T16:08:15.9847772+08:00`
- T1 `2026-10-05T16:38:15.9847772+08:00`（+30分钟；未重置、未续期）
- 同一窗口总上限 US$1 /100000 tokens /32请求；单次输出8192、requireComplete=true，原模型/端点保持。

只运行一次正式命令：
`node --import tsx packages/her/src/growth-experiment/cli.ts pilot D:/@Her/tmp/growth-live-20261002 evals/pilot02/plan.json`

命令 exit1。[完整执行输出](pilot02-live-evidence/execution.log)、[冻结输出](pilot02-live-evidence/freeze.log)、[完整执行证明及文件SHA](pilot02-live-evidence/execution-proof.json)。正式 CLI/连续 runner 进入 discover，仅第一个供应商请求失败，随后 state blocked、pilot-report 与 pilot-stop 均持久化。没有重试、备用模型、连通探针、后台实验或部署。

runId `22a375bc-7a52-4470-a90f-4fd5f895e3b6`，实际 model-reserve 在 `2026-10-05T08:08:16.596Z`，HTTP回执 `2026-10-05T08:08:17.067Z`，stop `2026-10-05T08:08:17.076Z`。供应商返回 **HTTP402**；[官方错误码](https://api-docs.deepseek.com/quick_start/error_codes/) 定义为余额不足。没有查询账户具体余额或自动充值，也没有把HTTP402推定为零费用。

诊断原值：choiceCount0 /contentBytes0 /reasoningBytes0 /usageStatus missing /modelIdentity requested-fallback。没有真实返回模型身份、结束原因、有效模型正文或usage；日志里的 deepseek-v4-flash 是请求名 fallback，不能冒充观测到的模型。宿主原错误正文为 `model request failed: HTTP 402; finish=unknown; contentBytes=0; reasoningBytes=0`，停止原因为 `real usage/model identity required; spend remains reserved`。HTTP错误body按原适配器规则未保存/打印，不能补造模型回复。

## 问题、实验、原始方法与四题对照

实际初始经历：[原JSON](pilot02-live-evidence/original-experiences.json)、[实际学习输入来源](pilot02-live-evidence/original-learning-input.txt)。来源是已发生的 Windows/Git 只读检查失败；精确SHA保留，未给根因、修复方法或评分答案。模型没有返回问题；自选实验0、观察0、候选方法未形成，独立门禁未达到，开发、修正和共同反思均未执行。不能把宿主停止叫作模型主动边界判断。

原始模型方法/回复：**不存在有效模型正文**。保存的是原始HTTP状态及受控诊断，不能写手工方法填空。完整 [report](pilot02-live-evidence/report.json) 保留八个注册条件，均未达到；任务/期望冻结在 [实际plan](pilot02-live-evidence/frozen-plan.json)，没有更换输入或重考。

| 新题 | A控制 | B方法检索 | 达标/复用/迁移/调整/边界 | 实际tokens/USD/耗时 |
|---|---|---|---|---|
| T1 Git LF配置 | missing | missing | 未测 | 两组均null |
| T2 混合文本视图 | missing | missing | 未测 | 两组均null |
| T3 大小写与换行语义 | missing | missing | 未测 | 两组均null |
| T4 同长度不同二进制 | missing | missing | 未测；未判断最终方法是否适用 | 两组均null |

不得把缺测计0分、从分母删除，或声称两组同样失败所以“没有收益”。该轮在模型响应前被供应商余额条件阻断，无法评估学习和净收益。

## 所有实际用量、未知记录与交付层级

本实验供应商尝试 **1次**，实际 tokens **unknown**，实际 USD **unknown**；预留13599 tokens /US$0.0163188，仅是预留，不能作实际消费或可靠账单。没有 model-result/伪零结算，新 model-unknown 与原预留保留。[原journal](pilot02-live-evidence/growth-pilot-02.md) 和 [只读审计](pilot02-live-evidence/journal-audit.json) 可逐条核对：reservationDigest `8c5325717877753db8f66918b544688375f9bf130aa992767f422f4e1194925d`，unknownDigest `00cf3ff234182699816e95aaf132798be2c379a99053b887cac07a4e3750a605`，stopDigest `e93b95c75038fd2e20f499c60ff3222a4f3ff0fe72f3b87227279e0d4b7e3569`。

历史成功 probe146tokens/US$0.0001131estimated，旧Pilot01两次9419tokens/US$0.0099114estimated：已知小计9565tokens/US$0.0100245estimated，历史原失败仍unknown。加本轮后已记录尝试共5次，其中3次有真实usage、2次unknown；总tokens/USD依然unknown。费用估算不是供应商账单，本轮不添加新的人工未知风险豁免。

实验已永久停止；原30分钟时窗即使尚未过期也不能重放。旧风险决定仅覆盖那条历史请求，不覆盖这条新unknown。充值/账户恢复不自动解除未知用量、停止或一次性批准门禁。完整成长 Goal 尚未完成；后续必须有实际外部条件改变并重新评估授权及未知费用，不自动另开Pilot。

本轮只交付真实失败证据/实际Her台账，同一独立分支正常commit/push，真实SHA与实时远端证明回填 PI-PILOT02-RESULT-COMMIT.txt。源代码未改、不合并、不部署、不启用后台学习；工程249项通过与本次实际HTTP402分别列示。