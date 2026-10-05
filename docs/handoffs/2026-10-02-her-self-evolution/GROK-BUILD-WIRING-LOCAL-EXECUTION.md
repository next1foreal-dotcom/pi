# Grok Build 成长宿主接线 — 工程通过，真实实验未启动

2026-10-05。用户明确要求 Samantha 成长实验使用已安装 Grok Build 的原生 OAuth 订阅。当前控制聊天模型未改变；不走本地 Codex Router 的自动重试/零填充通道，不改全局 Grok 或 Her 配置。

工程起点 pi `f70921ae25fdea4f1af6cf4aeb4dc0a431b59518`，独立分支 `codex/her-self-evolution-integration-20261002`。本次只增加已有 GrowthHost 的显式 native model port，沿用发现、最多两次自选实验、方法独立门禁、开发失败修正、同源反思和四题八条件 runner。没有合并或部署。

## 实际接线

- 正式 `growth cli → protected plan → GrokBuildModel → HerGrowthHost → 原连续 pilot`。计划显式选择 `model.grokBuild`，冻结 native executable SHA256、OAuth 文件引用、模型/端点、reasoning、生成设置和限额。当前支持已核查价格的 `grok-4.5`；API 等价估算单价下限 input 2 / output 6 USD 每百万 tokens，cache input 保守按未缓存计价。原 DeepSeek 配置不变。
- 每个请求使用隔离的非 Git runtime、HOME/GROK_HOME 和 leader socket；只引用现有受保护 auth，不读取/复制其内容。禁用 API-key auth、所有工具、web、subagents、自动标题、doom-loop resampling、自动更新、规则/技能导入、建议及重试。`max_completion_tokens` 与宿主输出限额一致，`max_retries=0`，rate-limit 总尝试阈值 1，`max-turns=1`。实际 native 回执还必须报告恰好一轮/一个 model call，缺失或不完整即停止。
- 新 native owner 授权明确使用 `modelProbe: {scope: "first-discovery-response"}`，且受保护人工批准中 `acceptsNativeLimits=true` / `nativePolicy` 必须逐项匹配。首个真实 discover 请求同时验证通道，不另做连通探针。只有完整结束、有效正文 JSON、native 身份和实际 usage 匹配才写 `nativeReadiness=model-ready`；它仅证明通道，不证明学习。
- Native `json` 用量按 uncached input + cache read + cache creation + output 总计；output 内含 reasoning，不二次相加。完整整数及原始 total 必须一致。缺失字段、错误 session、错模型、多次调用、不完整 usage、非最终结束、错误退出、超出预留均停止，不重试。OAuth 美元回执缺失或 partial 时 `providerReportedUsd="unknown"`；`usd` / `costBasis="api-equivalent-estimate"` 单独标注为停止线估算，绝不是账单。
- 原历史 unknown 仍保留。新增 `additionalHistoricalUnknown` 只能引用明确指定的已停止前一 pilot，匹配原计划/预留/人工风险决策 digest；受保护批准还必须单独接受该项。不能自动生成风险决策或结算。其他 unknown、其他 inquiry 的缺失订阅美元回执、STOP、过期、并发开销、已消费批准、失败和永久 pilot-stop 都继续阻断。

配置字段及回执解释来自[官方配置参考](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md)和[官方 headless JSON 协议](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)。API 估算价格来自[官方 Grok 4.5](https://docs.x.ai/developers/models/grok-4.5)。[公开 Responses 输出限额](https://docs.x.ai/developers/rest-api-reference/inference/responses)不覆盖 reasoning；订阅 native 服务的 reasoning 请求前硬上限仍未验证，不能宣称已有硬限额保证。

## 验证和失败记录

- `node --import tsx --test` 显式 12 个 growth 文件：223/223，exit 0，skip 0，完整命令与输出见私有续接；公开 `grok-build-wiring-evidence/growth-regression.log`。
- 末次边界回归显式 `growth-grok-build.test.ts growth-pilot-authorization.test.ts model-response-boundary.test.ts`：92/92，exit 0，skip 0；`boundary-regression.log`。两批重叠 51 项，合计去重 264 项，非 315 项。最后新增两个错误/外部 unknown guard 已在第二批验证。其他 runner/probe/applicability 实现未改。
- 完整 `npm run check` exit 0；`npm-check.log`。保留原来五个 useTemplate info，新增 warning/error 0；已通过类型、依赖、入口图、shrinkwrap/install-lock 和 browser-smoke 检查。
- 本轮中间检查曾因新 unused import / TS2339、TS2540 失败，修复后完成上述验证；新增测试最初命中了更早的并发开销 guard，修正合成历史的时窗后确认未知费用 guard。原失败日志保留私有 work，未删改事实。
- 新 native 工程测试使用注入 executor 和预设 JSON；无 OAuth 账号调用，不能算 Samantha 自主学习。原有工程测试的 loopback HTTP/实际本机 observer 也不能替代真实模型实验。
- 已安装 CLI 的前一轮 `inspect --json` exit 0 只证明配置层可读。更新禁用标题和重采样后的第二次 inspect 被自动审批拒绝，工具仅返回 `blocked by policy`，没有绕过或重跑；最新 native 配置未取得真实 wire/provider 验收。

## 实际实验状态与待验项

本次 Grok 供应商请求 **0**，没有新 T0/T1、人工风险决策、model-ready、真实问题、观察或方法。没有四题结果，完整成长 Goal 仍未完成。付费/订阅实验待一次已提出的明确条件批准：保留并接受 Pilot02 的特定 unknown；美元回执缺失继续 unknown、US$1 用作 API 等价估算停止线；reasoning 按实际返回计量，允许单次越过预留后立即停止。不得将选择 Grok Build 解释成这项新增风险授权。

Pilot02 原 HTTP402、run `22a375bc-7a52-4470-a90f-4fd5f895e3b6`、13599 tokens / USD 0.0163188 预留、实际用量 unknown 和永久停止全部保留。本次重新核对原 frozen plan、owner approval、journal、原始经历和学习输入五个文件，SHA256 均与已交付证据相同，见 `proof.json`。旧 Pilot01、失败请求与单次 probe 没有重发/重启；历史风险总账仍 unknown。

获批后只能在工程准备完成、首次实际 discover 前冻结一个新 30 分钟窗口；最多 32 个全部供应商请求 / 100000 actual tokens / US$1 API 等价估算停止线，输出 8192，requireComplete=true，两组同设。失败或新未知用量立即停止。真实通道调用、供应商限制兑现、native 身份/usage、Samantha 问题/自选实验/方法/独立门禁/四题公平对照/迁移/调整/修正/主动边界判断均未验证。
