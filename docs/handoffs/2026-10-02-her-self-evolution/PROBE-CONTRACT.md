# Pilot 01：先修工具协议，不进入 P2

状态：隔离源码候选；没有启动第二场付费实验，没有合并或部署。本发布不等于向本机 Codex 发送消息。

## 最新事实

integration 提交 73494f083ca349749a7193c0298c8129f37de144 的 GROWTH-PILOT-01-LOCAL-EXECUTION.md 和原始 model-receipts.json 显示：Samantha 提出问题和一次实验，实际 action 把 input.kind 的 git-status 用作 operationId，批次各项又缺 kind。宿主正确拒绝，2 次模型请求、9419 tokens，未执行 probe、未形成方法或跑对照。0.0099114 美元为冻结单价估算，不是供应商账单。

因此暂停 P2 新实现，先修这处可复现的协议问题。不要把它归结为通用学习能力已被证伪，也不要称作成长成功。

## 这份补丁

基线 host.ts Git blob：a881772b0b30f4b313941504437b37cc8a3158cb。补丁含 4 个仓库文件：host.ts 的小接线改动、新 probe-contract.ts、18 项协议测试和历史 action 测试夹具。

- operationId 只从宿主目录枚举；kind 是输入判别字段，不能当工具名。
- 新的可选 probeInputContract 由宿主在新计划里明确声明，同一合同同时用于模型目录和本地校验。批次每项必须有判别字段及必填参数。
- 未知工具、缺字段、类型错误、批次过长、额外字段不会自动映射或补全；拒绝时追加 probe-validation-rejected，保留字段路径和原 action 摘要。
- 原 grant/consume、sealed-case 检查、预算/STOP、pilot-stop、模型和独立评测保留。runProbe 在 consume 前再查结构。结构通过不是执行授权。
- 不改 loop 状态机，不新增供应商调用，不自动纠错或重试，不把人工测试中合法 action 回填成 Samantha 的输出。

合同是受限形状描述，不是完整 JSON Schema、语义验证器或沙箱。其类型定义和测试说明 string/boolean、枚举、hex、判别字段和单层批次。旧计划无合同则明确显示未声明，不自动修改冻结计划。下一份合同必须按实际工具源码审查；工具内部语义和组合长度检查仍不能删。

## 本轮验证与边界

18/18 协议组件测试通过。执行完整且字节核对过的 host 源码的 10 项聚焦检查通过；journal、grant、模型和执行基础设施为显式替身。相同检查在原 host 上 4 pass / 6 fail，缺少新功能不等于 6 个线上漏洞。

原 observer 的 text/binary 两个真实子进程运行成功，输入是合成数据；没有运行 Windows Git 路径。严格局部类型检查覆盖新协议模块和测试。精确基线上的 patch check/apply/逐文件字节核对/reverse check 通过。解包器核验、解压字节及拒绝覆盖检查通过。

完整日志、baseline/source、复现脚本与替身说明在本轮聊天包 her-probe-contract.zip；本目录提供可应用补丁。未运行本增量的完整仓库 npm run check、Windows/全部旧回归、真实模型或学习实验。没有修改实际 Her BACKLOG 或声称 P1/P2 达标。

## 同一本机 Codex 接续

1. 读取实际最新两仓规则、BACKLOG、工作区状态，保留已提交/未提交内容。当前版本若已前进，逐项合并，不整包覆盖，不另建 GrowthHost。
2. python unpack_probe_contract.py --verify-only，再用 --output <不存在的临时路径> 解包。审查并 git apply --check --whitespace=error-all 后，仅在独立任务工作区应用。
3. node --import tsx --test packages/her/test/growth-probe-contract.test.ts；随后真实 growth-host/CLI/模型相关回归和 npm run check。新增真实依赖测试验证合同随计划冻结、校验先于 grant、日志失败不放行、sealed-case 保留。
4. 在下一份尚未冻结的宿主计划中审查并声明 probeInputContract；不要改已结束 Pilot 01。接口描述不能包含研究答案、最终考试或预写方法。
5. 当前仅做无付费工程修复。已关闭的 pilot-stop、旧未知费用、原预算/窗口/人工决定保留；没有授权自动开第二轮。若以后批准协议修正调用，必须预先计入共享总预算，由 Samantha 自己重提案。
6. 已知另一阻断：原 observer 的 applicability 分支恒返回 unknown。下一场方法使用前必须完成可核实前提的验收，不能改回关键词猜测或恒真。本补丁未解决这个独立问题，不能据此承诺整个成长链可完成。

完成真实工程验证、准确更新实际台账后，沿用已有独立分支 commit/push 授权；不绕过 hooks/签名/anchors，不自动合并或部署。
