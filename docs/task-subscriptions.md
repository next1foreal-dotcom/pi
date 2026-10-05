# 本地任务订阅：实现与验收

更新：2026-10-05。分支 `feat/task-subscriptions-20261005`，基点 `ece3ebd19a95491175bc5d8164daee4172ae2e81`。

本地功能、122 项相关机测、真实模型执行链、Samantha 权限审查和虚拟终端交互均已验证。全仓检查及提交前 hook exit 0；5 条既有样式提示已用等价模板字符串修正。本文记录实现验收，提交与远端同步以 Git 记录为准；未合并或部署。

## 使用与范围

在常驻 Samantha TUI 的当前会话中，可以要求：“订阅任务 <taskId>，任务结束后读取输出，报告实际结果；不做修复、不派新任务。” 工具逐字保存用户要求，任务终态后由已有空闲轮询唤醒一个受限的只读回合，读取输出、保存证据，再单独显示报告。

第一版只接本地后台任务，未实现 OpenAI 插件事件协议、Webhook/SSE 服务、远端 PR 订阅或 Studio/Gateway 投递。RPC/print 拒绝新建订阅。应用关闭期间不运行；重新打开原会话后可恢复。其他会话不能接管订阅。

| 工具 | 参数与用途 |
| --- | --- |
| `her_task_watch` | `{ taskId, instruction, expiresAt? }`：订阅未结束的本会话任务，或无 owner 的任务 |
| `her_task_watch_list` | `{}`：列出当前会话订阅、事件、阻塞原因与保存的报告 |
| `her_task_watch_update` | `{ id, action: "pause" \| "resume" \| "cancel" }` |
| `her_task_watch_result` | `{ summary, evidence: string[] }`：只能由当前有效处理租约保存报告 |

每个任务最多一条订阅。相同请求重复创建幂等；不同 owner/请求拒绝。暂停保留事件，恢复重置耗尽的尝试次数，取消作废在途租约。取消不停止底层任务。已完成、取消或过期的订阅不能恢复。订阅接管该任务通知；暂停/取消/过期时也不会回退为旧式自动报告。工具位于现有 `background` 能力组。

## 实现与权限

规范状态保存于 `<HER_MEMORY_DIR>/subscriptions/tasks/watch-<task hash>.md`，包括 owner、用户原文、事件、租约、处理结果和送达状态。复用 `storeLock` 与原子写入，不增加数据库或依赖。

- 终态事件以 task id、创建时间和终态计算稳定标识；更新 `notifiedAt` 不制造新事件。
- 随机 token + 5 分钟可续租租约，拒绝旧 token 写结果。连续失败最多 3 次，之后等待用户主动恢复。
- 复用现有成本和唤醒预算，预算拒绝保留 pending 事件及原因。扫描可以恢复已被旧逻辑标记 notifiedAt 的终态。
- 报告入队不等于送达；检查聊天记录中匹配 subscription/event id 的 `custom_message` 后才确认。通知预留期为 5 分钟；不宣称数学上的 exactly-once 或用户已阅读。
- 处理回合仅开放 `read/grep/find/ls/her_task_output/her_task_watch_list/her_task_watch_result`，同时由工具调用守卫拒绝其他工具。报告是模型分析，不代表独立验收。
- 管理工具标为 destructive，default Cedar 具名授权；heartbeat/plan 拒绝。运行时 `allowed` 每次执行真正的 Cedar 判断，原有权限检查先于订阅守卫。
- 模型自动重试也会发出 `agent_end`，因此只在 `agent_settled` 后恢复工具和释放处理状态。租约限制贯穿重试。
- 通知中的模型报告也经 `fenceUntrusted`，转义伪造的边界标记，并明确说明它不是用户/系统指令。
- TUI 自定义渲染器仅显示处理状态、结论与依据，保留“模型报告 · 未独立验收”；内部事件指令与安全边界标记不直接显示。模型上下文与持久消息内容保持原样；显示时去除 ANSI 控制序列。
- 会话退出时，在途轮询可能遇到失效上下文；整个轮询边界捕获并记录错误，避免未处理 Promise 拒绝导致退出崩溃。

主要改动为 `packages/her/src/task-subscriptions/{store,runtime,tools,render}.ts`、5 个对应测试文件，以及 `extension.ts`、`bg-task-reconcile.ts`、`governed-tools.ts`、default Cedar 的小范围接线。任务费用结算、重试、清理仍运行；未订阅任务保留原路径。未改 coding-agent 源码、默认供应商/模型/网络设置或系统定时任务。所有新增源代码/测试文件小于 1,000 行；已有 extension 超过此限制，本轮未顺手重构。

## 验证证据

| 检查 | 结果 | 本地证据 |
| --- | --- | --- |
| 相关回归，含 30 个新增测试 | **122/122，exit 0** | `work/task-subscriptions-regression-final.log` |
| 真实 AgentSession + faux provider | 正常、重载、自动重试 3/3 | `work/task-subscriptions-session.log` |
| 本次改动及调用方类型检查 | exit 0 | `work/task-subscriptions-scoped-typecheck.log` |
| 全仓 `pnpm run check` | **exit 0**；类型、依赖、imports、entry graph、lock、browser smoke 均通过 | `work/task-subscriptions-full-check-final.log` |
| 提交前格式修正 | **66/66，exit 0**；完整 hook check 通过 | `work/task-subscriptions-precommit-core-tests.log`、`work/task-subscriptions-lint-commit.log` |
| 浏览器打包/tree-shaking smoke | exit 0；仅打包检查 | `work/task-subscriptions-browser-smoke.log` |
| 真实 TUI + xterm VirtualTerminal | **PASS，exit 0**；键盘输入、120×40 / 80×24 渲染、一次处理与一条报告 | `work/task-subscriptions-tui-acceptance.json`、`work/task-subscriptions-tui-smoke.log` |
| Samantha 真实评审 | 首次 CHANGES_REQUESTED；修复报告边界、补全权限调用链证据后 **PASS** | `docs/task-subscriptions-samantha-review.md` |
| 真实模型 + 本地后台进程 + 持久会话重开 | **PASS，exit 0**，一次处理、一个报告 | `work/task-subscriptions-live-acceptance.json`、`work/task-subscriptions-live-smoke.log` |

真实模型沿用 `her-gateway / xai/grok-4.6`。通过案例：任务 `t-20261005-8sivsu`，会话 `01a10bff-0f2f-77a6-817a-ff5931d4f91c`。实际 Node 子进程输出 `HER_SUBSCRIPTION_LIVE_OK` 并以 0 退出；模型登记订阅后关闭并重开持久会话，自动读取全部 25 字节输出，保存报告，并确认聊天记录只有一条报告。校验了全局 settings 文件未变。

真实模型验收覆盖 AgentSession 的 TUI 模式执行链。随后以 faux provider、真实 InteractiveMode 和项目自带 xterm VirtualTerminal 验证键盘输入及屏幕内容，并读取两种尺寸的完整 viewport。报告可见且无内部订阅指令/边界标记；这是终端仿真验收，不是 Windows 原生终端截图或用户亲自验收。显示层发现的问题有先失败后通过证据：`work/task-subscriptions-tui-internals-red.log`。显示修复未修改模型输入或权限，所以没有重复付费模型调用。第一次真实 smoke 的业务链通过但退出崩溃，保留于 `work/task-subscriptions-live-smoke-shutdown-red.log`；补上失败测试并修复后，第二次整条命令 exit 0。退出时已失效上下文会留下诊断日志，未冒充零警告运行。

命令（从工作树根目录执行；真实模型脚本会产生实际模型调用）：

```powershell
node --import tsx --test packages/her/test/task-subscriptions*.test.ts packages/her/test/event-wake.test.ts packages/her/test/bg-task-owner*.test.ts packages/her/test/bg-task-g188.test.ts packages/her/test/bg-task-g125.test.ts packages/her/test/bg-task-envelope.test.ts packages/her/test/extension.test.ts packages/her/test/tool-disclosure.test.ts packages/her/test/governed-tools-failsafe.test.ts
pnpm exec tsgo --noEmit -p work/task-subscriptions.tsconfig.json
pnpm run check
pnpm run check:browser-smoke
node --import tsx work/task-subscriptions-live-review.mjs
node --import tsx work/task-subscriptions-live-smoke.mjs
```

全仓检查已通过。提交前将 3 个文件中的 5 处字符串拼接改为等价模板字符串，单独记录于 `dac69bb61`，66 项 her-core-modules 测试通过；提交 hook 的完整检查无 Biome 提示。先前 hydration 从实时目录取得的数据删除了旧模型 id，导致同一源码基线也出现 19 个错误。已先备份实时目录到私有 `work/model-data-live-20261005`，再从相同 HEAD 的 `D:/@Her/wt-cua-0333-20261005` 复用已验证的完整模型数据（manifest generatedAt `2026-09-27T07:43:01.572Z`），逐文件 SHA256 一致，仓库 `check-model-data.ts` 验证通过。数据是被 Git 忽略的构建输入，没有改 AI 测试、生成器、默认模型或供应商。此结果证明当前本地快照可通过检查；未来重新下载实时目录仍可能发生漂移，未声称解决全仓目录可复现性。

## 测试隔离事故与恢复

续跑时，一个带超时的测试在异步清理结束前进入下一场景，导致环境变量被恢复，测试扩展误读默认 `D:/@Her/her-memory`。确认新增了一条旧目标的认领记录，但没有执行旧目标。已先备份该记录，再核对变更仅为本次认领，恢复到原 Git 基线，`git diff --exit-code` 验证无差异。相关审计日志保留，不删除失败证据。

测试已移除会导致场景重叠的外层超时，改用真正可重载的资源加载器，并在每次扩展初始化前断言隔离目录。随后 3 个真实会话场景通过；最新 122 项相关回归全部通过。

`work/` 中包含本地日志、会话、隔离目录、身份文件副本和恢复备份，属于私有验收证据，**不要整体暂存、提交或推送**。可提交的评审摘要单独放在 `docs/task-subscriptions-samantha-review.md`。

## 交接与未执行项

建议 BACKLOG 条目：本地任务订阅实现、122 项相关回归、全仓 check、真实模型持久会话恢复、虚拟终端交互及 Samantha 审查通过。外层 Her BACKLOG 随未来功能集成一起回填，当前保持其无关脏改动不动。

本功能仅交付功能分支，未合并或部署。未实现 Studio、外部 MCP 或应用关闭后的系统级唤醒。未进行原生桌面终端人工验收，未宣称可直接生产发布。

发布前回退可直接不集成本分支；若以后已集成，应整体回退功能提交并归档订阅状态。仅移除路由并不会让旧 `notifiedAt` 任务自动重放报告。
