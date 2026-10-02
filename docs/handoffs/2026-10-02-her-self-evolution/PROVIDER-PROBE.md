# 原 Codex 会话接续：模型响应探测

## 当前目标

在现有 GrowthHost 上先取得一条“有效正文、实际模型身份、有效用量、持久回执”同时成立的响应，再继续发现→学习→迁移→修正。不要重建宿主或叠加旧聊天版本。

本包是隔离候选，运行时代码未应用。本次远端读取 integration HEAD 为 e2a9e23b850917f7ee19a2d3bf91653051ca9876；不代表本机未提交状态。保留原会话工作，读取本机最新 AGENTS/BACKLOG 后继续。

## 代码

累计补丁包含上一轮响应诊断、不可变失败元数据和冻结请求选项，并新增 `HerGrowthHost.probeModel()` / `growth probe-model`。四个既有源码文件：her-core/model.ts、growth-experiment/model.ts、host.ts、cli.ts；三个新 TS 测试。

新命令只做一次随机 JSON 挑战。调用原有模型请求、预算预留、用量记录、STOP、过期检查；不初始化研究、不调用 advance、不使用留出题、不自动重试或继续学习。成功回执写入原 journal 才返回 model-ready；错误 JSON 返回 probe-failed，CLI exit 1。provider 异常继续向上传播。

计划必须在冻结时已设 requestOptions.requireComplete=true。不默认改思考模式、模型、输出额度、凭据或预算。旧未知用量、未结算预留和过期窗口不清除；这不是跨 inquiry 预算修复。

## 本机执行顺序

1. fetch 本交接分支，只读取本目录，不合并到运行分支。不要叠加应用上一轮累计 provider 补丁。
2. `python unpack_provider_patch.py --verify-only`，再 `python unpack_provider_patch.py --output <新的临时补丁路径>`。校验 PROVIDER-PROBE-MANIFEST.json 的基线文件，读取差异并运行 `git apply --check --whitespace=error-all <补丁路径>`。版本不同先合并差异，不覆盖当前源码。
3. 在任务独立工作区应用并运行：

```sh
node --import tsx --test packages/her/test/model-response-boundary.test.ts packages/her/test/growth-completion-policy.test.ts packages/her/test/growth-model-probe.test.ts
```

再运行已有模型、growth-host、CLI 和受影响回归，以及完整 `npm run check`。把附带说明中的宿主/CLI 条件放进真实依赖夹具核验，不能用隔离加载器证明全仓通过。

4. 先处理原真实请求用量凭证。已公开 journal 只有 model-reserve，没有 model-result。6877 tokens / $0.0082524 是预留，不是实际账单或可靠上界。不能补造0、清 journal、换 root 或 inquiryId 绕过。
5. 原20分钟窗口已过期；只有本机确有有效的新授权和一致会计处置后，再冻结窗口与显式请求选项。不得自行续期。缺真实凭证时保持未知；其他风险处置只能由用户明确决定。
6. 满足上述前置条件后，在完整工程根目录运行一次：

```sh
node --import tsx packages/her/src/growth-experiment/cli.ts probe-model "<获准实验根目录>" "<冻结计划相对路径>"
```

检查 model-ready、runId、planDigest、reportedModel、tokens、estimatedUsd。费用是使用真实usage按冻结单价计算的估算，不是发票。成功仅证明本次响应有效，不证明成长。随后在剩余有效预算内继续原实验，方法仍由 Samantha 提出。

## 调查线索

旧失败 journal 的 maxOutputTokens=2048，未显式设置请求选项。DeepSeek 当前文档说明默认开启思考、默认effort=high。因此“额度在最终正文之前耗尽”值得排查，但旧响应缺失 finishReason / reasoningBytes，不能确认根因或还原用量。不得拿reasoning_content充当答案。

官方文档：https://api-docs.deepseek.com/api/create-chat-completion/ 。旧模型别名可能被路由到后续版本，真实身份仍需记录；不要假设请求名就代表固定权重。

## 提交和交付

沿用原任务独立分支 commit/push 授权，相应全仓验证和实际台账更新完成后正常提交；不复用一次性 anchor override、不强推、不合并或部署。

本次 GitHub 提交只发布交接和隔离补丁，未在本机运行 hooks 或检查、未向正在运行的 Codex 自动发消息。下一件实物是有效模型回执或明确阻塞，不是更多模块。
