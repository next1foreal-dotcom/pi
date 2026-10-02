# Provider probe 实际执行回执

本轮只接入响应边界并运行用户明确授权的一次 provider probe。已停止模型调用；不自动继续发现→学习→迁移→修正，不合并运行分支，不部署。

## 交接与改动

- 已 fetch `codex/her-self-evolution-handoff-20261002`，读取提交 `a3b99d70edfab71ef9db18712abd8c4eb953fae4` 的 PROVIDER-PROBE.md 及累计补丁。
- 四个基线 Git blob 与 integration HEAD `e2a9e23b850917f7ee19a2d3bf91653051ca9876` 全部相同；xz/patch 长度、SHA256 及应用预检通过。累计补丁仅应用一次，没有叠加上一版。manifest 和解包器保留原交接字节。
- 共享模型边界保留不可变失败 metadata、有效 usage 和安全诊断；正文、reasoning、finish_reason、模型身份分别校验。默认调用方的思考模式/输出策略不变。
- 真实 GrowthHost 和 standalone/formal CLI 复用原 journal、storeLock、预算、STOP、模型 adapter、cost audit。probe-model 只验证随机 JSON 响应；model-ready 必须在持久回执后返回。
- 用户后续明确接受旧请求未知费用风险，并另批单次 US$0.10 / 10000 tokens / 10min，保留输出上限 2048、当前端点和模型。新增受保护的授权文件参数，只绑定原 inquiry、冻结 planDigest、旧预留 digest 和单独人工决定 digest；不改旧计划。消费前持久预留，跨进程禁重放；新未知用量不能继承例外。底层 singleRequest 禁止连接恢复重试和重定向。
- 旧模型连接测试的 SyntaxError 断言迁移为 core 的 CompletionResponseError/invalid_json；summary adapter 保留原断言。未知身份响应的可观测 usage 保留在 model-unknown，不能用于结算。

## 工程验证（完整工程依赖）

| 命令/范围 | 实际结果 |
|---|---|
| `python …/unpack_provider_patch.py --verify-only`；输出补丁；`git apply --check --whitespace=error-all …` | 各 exit 0 |
| `git apply --whitespace=error-all …`；`git apply --reverse --check …` | 各 exit 0，应用一次 |
| `node --import tsx --test --test-name-pattern=probe-model packages/her/test/growth-host.test.ts`（接入前） | 11/11 RED，exit 1，真实宿主/CLI 缺入口 |
| 新单次授权条件 RED（实现前） | 13 项，11 拒绝条件通过、2 正向/消费条件失败；exit 1 |
| 46 文件宽回归，完整 argv 见 provider-probe-final-test-argv.json | 611 项，607 pass / 4 fail / 0 skip，exit 1，440838.5563ms |
| 未改的 e2a9e23b… 独立完整 worktree 上复现两项时间测试 | 两项均相同 true !== false，exit 1；不是 loader/依赖失败 |
| 错误类型迁移后 5 文件聚焦回归（model-connect-timeout、model-response-boundary、growth-completion-policy、growth-model-probe、growth-host；concurrency=1，tap） | 111/111，0 fail / skip / cancelled，exit 0，13943.8361ms |
| 最终 `npm run check` | exit 0；完整 lint/type/依赖/入口图/shrinkwrap/install-lock/browser-smoke；5 条既有 infos |

宽回归 4 个 fail 中，模型 JSON 断言和其父子测试汇总占 2 个计数，已迁移并复跑通过。剩余两项为 persona.test.ts 的 CLI not-due、skill-scan.test.ts 的 CLI not-due：夹具 NOW 固定为 2026 年 8 月，CLI 使用真实当前时间。已在干净 e2a9e23b… 基线复现，范围外保留；不宣称宽回归全绿。工程运行没有 root npm test/full Vitest、完整 build 或生产 E2E。测试预设回复与本地 HTTP 仅是工程验证，不计自主学习。宽回归后只改了模型测试断言；源码及其余测试 Git blob 未变，聚焦回归覆盖迁移及 provider/host/CLI。正常 commit hook 的检查结果另存于台账交付证据。

## 唯一真实请求

原目录 `D:/@Her/tmp/growth-live-20261002`，原 inquiry `windows-reader-inquiry`；没有换目录或 inquiry 绕过保护。

- 授权 T0：`2026-10-01T23:44:35.8689235-07:00`；T1：`2026-10-01T23:54:35.8689235-07:00`。新窗口固定 10 分钟，未重置/续期。
- 真实命令：`node --import tsx packages/her/src/growth-experiment/cli.ts probe-model D:/@Her/tmp/growth-live-20261002 evals/growth/plan.json evals/growth/provider-probe-authorization-20261002.json`。
- exit 0；请求命令 `23:44:35.8809714-07:00` → `23:44:37.2597350-07:00`，1378.7636ms。
- status：`model-ready`，仅 `provider-response-only`。runId：`bab894ed-95e5-47f9-ad22-092291ede92d`；responseId：`2336dfae-e347-4d2f-a00e-d710d7beb68b`。
- 请求模型 `deepseek-v4-flash` 不变；供应商实际响应 model 字段为 `deepseek-flash`；端点 `https://api.deepseek.com`，HTTP 200；finishReason `stop`。
- 实测 usage：prompt 69、completion 77、total 146；包含供应商返回的生成用量，不把 reasoning_content 当正文或公开内容。
- 正文：`{"probe":"9369a938-01fc-4703-b80a-681a5ecd2a81"}`。contentBytes 48、reasoningBytes 155；只保留 reasoning 大小。
- 费用 `US$0.0001131` 是真实 usage × 冻结单价 input $0.3 / output $1.2 每百万的估算，不是供应商发票或余额核销。官方当前价格页显示 Flash 高峰上限同上述单价、低峰减半；使用冻结高峰单价，不猜缓存优惠或更低实际扣款。[官方定价](https://api-docs.deepseek.com/quick_start/pricing/)。供应商报告的 model 名不证明固定底层权重。
- journal 新增恰一条授权预留、一条 model-result、一条 model-probe-result；cost audit 恰一条 growth-model，runId 对齐。禁止第二次请求的实现已在真实依赖测试覆盖，没有对 live provider 做第二次验证调用。

## 旧账与人工决定

本轮查阅旧实验目录、响应/step/status 日志、原 journal 与现存 audit，未找到失败请求的真实 usage；浏览器 inventory 的 Chrome 读取失败，未取得供应商账单，不声称旧请求费用已核实。旧 runId `e9e181c7-b228-4feb-929f-6e54da270947` 实际 tokens/USD 仍 unknown，6877 / $0.0082524 仅为旧预留，不是账单或可靠上界。没有填零、补造 model-result、重发旧请求。

人工风险接受单独追加为 journal seq=5，digest `18762bc558312f5d8581a85515228ca993a6ac54f1b3f128cd368f88968fc4a4`。新授权 digest `38182824527a8877e57da44aed23bcb44f89e6378895702247ea78914246a76e`，仅此一次消费；不取消其他未知、STOP、预算或权限检查。

原 journal 前 9558 bytes SHA256 仍 `a5f5f9374805d58b06b6a55f21716d9e3f7c309313c2bcb4385b47b2cf46b7a7`；原 plan SHA256 仍 `4367cb00ad1fa8b14fdc3cf3926e3e7b08306b44bb174b2c803920e4cdc11191`。追加后 journal SHA256 `5295b5196b568e8e3cae692847ee63ae0bbeab6e9e0bd4e8de803874e9c4a5c8`。原研究 state 完全不变：revision=2、blocked、thoughts=1、probes=0，无方法/迁移/修正。

## 未验与交付边界

真实 probe 只证明这一条响应有效。完整成长实验、真实 paired 技能收益、生产采纳及回滚、生产 JUDGE 仍未验；本轮用户要求停止后续实验。旧失败用量和供应商实际账单仍未知。两个时间夹具基线失败保留。没有 merge、deploy 或后台启用，没有重复 anchor override，也没有绕过 hooks/签名配置。

可审核数据在 provider-probe-evidence：命令/退出状态/全量日志、基线复现、受测源码 hashes、人工决定、不可变授权窗口、实际 journal/usage/audit。live 文件保持原始字节；检查日志仅统一行尾并保留本地/公开 SHA256。独立 pi 分支和实际 BACKLOG 台账分支在正常 hooks 后分别提交推送，真实 SHA 与远端 proof 存于台账伴随文件。
