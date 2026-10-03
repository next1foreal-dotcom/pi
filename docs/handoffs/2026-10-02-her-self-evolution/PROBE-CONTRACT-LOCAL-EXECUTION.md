# Probe contract：本机接线与工程验收

2026-10-03（America/Phoenix）。工程接线通过；Pilot 01 仍为 INCOMPLETE，适用性检查仍 BLOCKED。本轮供应商请求 **0**，没有启动 P2、重开窗口或更改模型/端点，没有合并或部署。

## 基线与改动

- 沿用 pi 独立分支 `codex/her-self-evolution-integration-20261002`，基点 `73494f083ca349749a7193c0298c8129f37de144`。实际 Her 台账在 `codex/her-self-evolution-ledger-20261002`，基点 `cf143bf3e75482dd40e55abb223eb869f3e99df3`。
- fetch 原交接分支后，读取指定 `2aa912401ce69b8157c16c12c422cfd94dfb7f72` 的 [PROBE-CONTRACT.md](PROBE-CONTRACT.md)。host 基线 Git blob 精确匹配 `a881772b0b30f4b313941504437b37cc8a3158cb`。
- 解包器校验和 `git apply --check --whitespace=error-all` 均 exit 0，累计增量仅应用一次。补丁 SHA256 `7c4693a7f256bc69cd6f9ea4e902542f753154ddee7e5de017a85e560c85dc56`。
- 同一份可选 `probeInputContract` 随宿主计划冻结，同时生成模型工具目录与执行前校验。明确 operationId 与 kind；批次每项包含判别字段与必填参数。拒绝缺项、错误类型、未知工具、超长批次及多余字段，不自动修复或映射模型 action。
- 校验失败追加 `probe-validation-rejected`，绑定 runId、planDigest、原 action digest 与字段路径；追加失败不放行。runProbe 在 consume 前再次验证，结构通过不能替代权限或语义校验。
- 本机发现并修复：新合同可自定义批次键，旧 sealed-case 检查只看 cases。现跟随合同 batch.key，旧未声明计划仍保留 cases 检查。已有 CLI、loop、journal、grant/consume、预算、STOP、pilot-stop、模型适配器与 BgTask 执行链均复用。

影响调用链：CLI step → loop.advance → host.reason / authorizeProbe / runProbe；loop.tryMethod → host.checkApplicability；host.review / runBaseline 继续使用原调用和预算机制。没有新增框架或模型调用路径。

## 真实依赖验收与复现

| 验收项 | 实际结果 |
| --- | --- |
| 新合同与计划共同冻结、到达 reasoner 提示 | 真实 host/journal 通过；修改已冻结合同后重新 open 被拒绝 |
| 历史 action 重放校验 | 与原 model receipt 逐字相等、SHA256 一致；仍拒绝，未生成 grant/consume/execution |
| 日志故障 | 仅注入 append 抛错，其余真实 host/journal/grant 不替换；拒绝向上抛错且无 grant |
| 执行前再次验证 | 已有 grant 后篡改 action 为无效 hex，consume 前拒绝 |
| 封存题 | cases 与自定义 samples 均拒绝 review/final 输入；原补丁在 samples 上 RED，修后 GREEN |
| 实际观察 | 原 observe.mjs 字节不改，经真实 BgTask 子进程执行 Windows Git、text-view、text-pair、binary-pair；核验输出及 .done/.log SHA256 |
| 语义边界与一次性执行 | 两个各 7000 字符的形状合法输入仍被工具的组合 12000 长度门拒绝；保留非零退出证据，不重放 consume |
| 适用性阻断 | 原 observer 的 applicability 分支真实返回 unknown、没有 met；真实 loop 进入 blocked，不授权或执行 use，不记录主动边界判断成功 |

预设 FakeModel 只用于工程提示和 selection 控制；它不是 Samantha 学习、形成方法或获得收益的证据。工程试验使用临时目录和合成输入，没有触碰已停止 Pilot 的执行根目录。真实子进程是工具链验收，不是新的付费成长实验。

新增测试开发初期有路径、drain 参数和 selection 夹具错误，记录保留在 host-red*.log；修正夹具后的 host-red-final.log 为 **9 pass / 1 fail**，唯一失败是自定义批次封存题保护。应用一行合同批次键接线修复后，协议+真实 host **28/28**，随后全相关回归 **170/170**。

## 命令与退出结果

均在完整工程 `D:\@Her\wt-self-evolution-20261002` 执行，使用现有真实依赖。

1. `git fetch origin refs/heads/codex/her-self-evolution-handoff-20261002:refs/remotes/origin/codex/her-self-evolution-handoff-20261002` — exit 0，取得指定提交。
2. `python work/probe-contract-handoff/unpack_probe_contract.py --verify-only` 与 `--output work/probe-contract-handoff/candidate.patch` — exit 0；`git apply --check --whitespace=error-all` 和应用均 exit 0。
3. `node --import tsx --test packages/her/test/growth-probe-contract.test.ts packages/her/test/growth-probe-host.test.ts` — exit 0，28 pass / 0 fail / 0 skip。
4. `node --import tsx --test packages/her/test/growth-probe-contract.test.ts packages/her/test/growth-probe-host.test.ts packages/her/test/growth-host.test.ts packages/her/test/growth-experiment.test.ts packages/her/test/growth-model-probe.test.ts packages/her/test/growth-completion-policy.test.ts packages/her/test/model-response-boundary.test.ts packages/her/test/model-connect-timeout.test.ts` — exit 0，170 pass / 0 fail / 0 skip，包含真实 CLI/loopback、模型响应边界、未知用量、停止和预算门禁。
5. `npm run check`（仅本进程 `RAYON_NUM_THREADS=1`，完成后恢复）— exit 0。包含全仓 Biome、依赖/入口/锁文件检查、tsgo 与 browser-smoke。保留 5 条既有 useTemplate infos：memory.ts 三条、jsx-attr.ts 一条、her-core-modules.test.ts 一条；没有新增诊断，未改无关代码。
6. `git diff --check` — exit 0。源码/测试行数与 SHA256 见 source-manifest.json。

仓内日志只去除行末空白和文件末空行，原始输出保留在任务私有 work/probe-contract-handoff；内容与退出结果未删改。全量输出：[回归日志](probe-contract-evidence/regression.log)、[完整工程检查](probe-contract-evidence/npm-check.log)、[RED](probe-contract-evidence/host-red-final.log)、[GREEN](probe-contract-evidence/probe-green.log)。未运行根 npm test/build 或付费 API；没有用局部检查声称完整仓库所有测试全绿。

## 历史保留和未验项

13 个历史文件（Pilot 原授权、计划、输入、失败/回复/停止相关记录、两个 inquiry journal 及旧计划）前后 SHA256 全部一致，见 historical-before.json / historical-after.json。历史 action 与 responseId `26e8f22b-0b95-43d0-8303-e37dd0e0c51e` 回执一致。

Pilot 01 仍是 **2 请求 / 9419 tokens / $0.0099114 冻结单价估算**（非供应商账单），probe 实际执行 0、方法 0、最终对照未跑；旧失败请求 actual tokens/USD 仍 unknown，预留不当账单，人工例外和原窗口不改。没有新增付费请求、重试、model-result 或学习记录。

**适用性检查欠账未解除**：原 observer 对自然语言 preconditions 恒返回 unknown。此次核对证明失败关闭，并未实现可核实前提解释器；下一场方法使用前仍须定义受信、可观察的前提合同与独立双侧验收，不能用关键词猜测或恒真放行。本协议合同只验证输入形状，不验证方法适用性或提供 OS 沙箱。

没有创建/冻结下一场实验计划。未来获授权的新计划需要按实际工具源码声明合同；本次测试中的四种观察合同只是工程夹具，不是对下一场调用的授权。模型是否会在新协议下正确提案、真实方法形成、独立门禁收益、复用/迁移/修正以及 Samantha JUDGE 均未验。协议通过不等于学习成功。

## 验收范围

本轮局部工程修复 PASS；完整成长链未通过验收。没有修改 upstream coding-agent、生产记忆/内在 journal、SOUL、调度任务、默认权限、模型或端点，也没有新增依赖。实际 Her BACKLOG 的快照/G-280/G-281 同轮追加工程结果及阻断，旧条目字节保留；仅更新时间定点替换。提交与推送证明由正常 hooks 后的真实 SHA 和 live ls-remote 另存 PI-PROBE-CONTRACT-COMMIT.txt（Her 台账副本），不预填 SHA 或声称部署。