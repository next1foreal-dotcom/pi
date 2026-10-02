# 交接发布证据与边界

## 发布范围

本次只发布 docs/handoffs/2026-10-02-her-self-evolution 下的交接材料，包括经过摘要核对的 V0.1 累计候选补丁。没有修改 packages/ 下的运行时代码，没有将补丁应用到当前 Samantha，也没有更新真实记忆或权限。

目标原始提交：3f918b0dddf373582f1629a7da22a66ade7f0498。
原始树：ccc62a43db0cdae182162521a64498a9b3835d98。
重新读取目标集成分支仍返回上述提交。

## 本轮实际重跑

在当前容器解压先前交付的 her-self-evolution-v01.zip，运行：

`python /mnt/data/her-publish-work/her-self-evolution-v01/reproduce.py --out /mnt/data/her-publish-work/fresh-v01-results`

结果分别为：

- components：106/106，通过，0 跳过，退出码 0；包含真实 Node 子进程和临时 Git 操作，任务仍是合成夹具。
- orchestration-with-infrastructure-doubles：8/8，通过，0 跳过，退出码 0；既有锁、台账等基础设施有替身。
- mechanical-with-peripheral-doubles：15/15，通过，0 跳过，退出码 0；部分外围依赖有替身。

在先前交付的 her-local-acceptance 目录运行 `node --check preflight.mjs` 和 `node --test --test-reporter=tap preflight.test.mjs`：语法检查退出码 0，工具测试 7/7，通过，0 跳过。

以上是既有离线结果复现，不是新完成的全仓验收。预检工具测试不属于 Agent 能力指标。

## 补丁传输与解包

累计补丁解压后 74002 字节，包含 15 个文件的差异。
补丁 SHA-256：d50aebad8ecd8f5e780b4c339356253b308772f47ba77b096e02b87ea6c81651。
压缩文件 16872 字节，SHA-256：d7c844996bfabfe8128133c36f7590235f4189f2f08c36a23f52f8a610fd3949。
上传后的 Git blob：549fb6c87da61a68e53ce4bc53ae1d5c83469a06，与本地计算一致。

unpack_patch.py 的 4 个临时文件验证均通过：只核验、输出与原补丁字节摘要一致、拒绝覆盖、拒绝损坏输入且不生成输出。这只是交接工具验证，不是运行时测试。

原完整离线复现包仍为聊天中已交付的 her-self-evolution-v01.zip；本目录提供可在完整工程应用的累计补丁，不复制替身加载器来伪装真实工程测试。

## 尚未执行

- 旧 selfmod 成功/失败夹具的完整迁移。
- 回滚错误关联修复及其完整工程验证。
- 完整仓库 npm run check、完整受影响旧回归、Windows 实机验证。
- 真实 Samantha 技能前后对照、真实采用、上线观察、生产回滚。
- 本机 Codex 启动或派工；没有本机 session_id 或执行日志。
- 实际 Her/BACKLOG.md 回填；BACKLOG-ENTRY.md 只是待回填材料。

容器 GitHub DNS 访问失败，GitHub 连接器仍可读写；本机终端插件查询仍显示未安装。这个限制不说明用户电脑的 GitHub 或 npm 访问也失败。

## 提交方式

用户本轮明确授权 commit/push。交接材料通过 GitHub API 创建提交并更新独立分支，而不是在用户电脑运行 git commit/git push。没有执行本机 hooks，也没有本机签名或本机测试通过的结论。没有强推、合并或部署请求。

工作由当前主会话直接完成；不声称本机 Codex 或其他模型已经执行此交接。
