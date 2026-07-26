# G-129 · Worker 产品包装：外部 CLI 默认工人（claude -p / codex exec）

> **文档类型**: 施工图（设计已定，照做）
> **日期**: 2026-07-26 · 作者: Fable 5（主会话）
> **上游依据**: `Her-repo/docs/spark/2026-07-26-background-tasks-and-artifacts-mechanism.md` §7 决策②、附录 F.2 / G / I
> **前置**: G-119…128 主环已 DONE（本卡不动 runner 协议与五层机制本身）

---

## 0. 现状（已亲核 file:line，2026-07-26）

| 事实 | 坐标 |
|---|---|
| `her_task_spawn` 工具要求调用方直给 `command` argv；`worker` 只是自由字符串标签 | `packages/her/src/extension.ts:1701-1708` |
| 可执行白名单 = `["node","nodejs"]` + `process.execPath`；**真 CLI（claude/codex）经工具面根本派不出** | `packages/her/src/her-core/bg-task-spawn.ts:23,54-75` |
| `allowExecutables` 是 spawnBgTask 的输入参数（调用方随传随过）；工具 schema 未暴露它（幸） | `bg-task-spawn.ts:31,84` |
| config 有 `tasks:`/`publish:` 两段解析；**无 `workers:` 段**；`default_worker:"cheap_worker"` 无解析逻辑，纯标签 | `bg-task-config.ts:10-60,100-137` |
| Windows `.cmd/.bat` 陷阱已解：`.cmd`→`cmd.exe /d /s /c`；裸名→`where.exe` 优选非 cmd 入口 | `task-executor.ts:24-56` |
| runner 把 worker stdin 钉死为 `"ignore"` | `task-runner.mjs:20` |
| 机制文契约：`worker` 必须是 config 档位键，不在 config → 抛错；档位值禁止型号字面量 | 机制文 L895, L1190-1202, 附录 G L1334-1337 |
| `.her/tasks/.gitignore` 已忽略 `*.pid/log/heartbeat/done`；**无 brief 条目** | `her-memory/.her/tasks/.gitignore` |
| 实机 `her-memory/.her/config.yaml` 尚无 `tasks:`/`workers:` 段（全靠默认值 + WARN） | 实机文件已读 |

## 1. 目标（一句话 + 成功画面）

Samantha 说 `her_task_spawn({ objective, worker: "codex", brief: "<全量任务包>" })` 就能把活派给**真外部 CLI**；档位在 `config.yaml` 定义（零硬编码型号），唤醒后 `her_task_output` 读到真 CLI 的输出。

## 2. Non-goals（本卡明确不做）

- 不做 `cursor-agent` 档位（CLI 未装；装好后 config 加一段即可，代码无需改动——这是本设计的验收标准之一：**加新 worker = 只改 config**）。
- 不改 runner 的 sentinel/heartbeat/杀树协议；不动 pi 上游包。
- 不做 worker 结构化回报解析（brief 里要求 worker 落盘产物；父环靠句柄分页读 log）。
- 不做 provider 降级/自动重试扩展（retry 语义维持 G-125 现状）。
- 不逐条补机制文 T/AC 欠账（那是另一张卡）。

## 3. 设计决策（已定，偏离需回 Fable 重拍）

### D1 · brief 经 stdin，不经 argv
`brief` 落盘为 `.her/tasks/<id>.brief.md`，runner 把该文件以只读 fd 接到 worker 的 stdin。理由（三合一）：
1. `.cmd` 垫片路径走 `cmd.exe /d /s /c`，argv 里的引号/`^`/`&`/换行会被 cmd 二次解析——**注入面**（附录 I）；
2. Windows 命令行 ~32KB 上限，真任务包轻松超；
3. `codex exec -` 与 `claude -p`（无 prompt 位置参数时）**都原生从 stdin 读 prompt**——零适配。

传递方式：launcher 设 `HER_TASK_STDIN=<briefPath>` 环境变量；runner 检测到该 env 时 `openSync(path,"r")` 作为 stdio[0]，否则维持 `"ignore"`。不改 runner argv 协议。

### D2 · 白名单收敛到 config
allowlist = `DEFAULT_ALLOW(node/nodejs)` + `process.execPath` + **workers 档位各 `argv[0]` 的 basename**。`allowExecutables` 输入参数降级为**测试钩子**（注释标明 test-only；工具 schema 继续不暴露）。`worker` 名不在 config → **抛错**（错误信息列出可用档位键），不 spawn 任何进程。

### D3 · worker 档位 schema（config.yaml）
```yaml
workers:
  codex:
    argv: ["codex", "exec", "--sandbox", "workspace-write", "-m", "gpt-5.6-terra", "-c", "model_reasoning_effort=high", "-"]
  claude:
    argv: ["claude", "-p", "--permission-mode", "acceptEdits"]
```
- 只有一个字段 `argv: string[]`（v1 YAGNI；prompt 一律 stdin，将来有 CLI 必须 argv 传 prompt 时再加字段）。
- 型号/effort/沙箱旗标全部活在 config——代码里**零型号字面量**（宪法 + 机制文 L895）。
- 解析沿用 `parseTasksPublish` 的 yaml-ish 风格；`workers` 是嵌套两层的段（`workers.<name>.argv`），现解析器只支持一层嵌套 → 在 `bg-task-config.ts` 扩展或在 `worker-profile.ts` 独立解析（实现者选，测试钉行为即可）。

### D4 · 两种 spawn 模式互斥
- **档位模式**：`brief` 必填 + `worker`（缺省 = `tasks.default_worker`）→ 命令 = 档位 argv；`command` 不许同给（同给 = 参数错误，抛错）。
- **裸命令模式**（保留，向后兼容 G-120…128 全部既有用法）：`command` argv 直给，argv[0] 必须过 D2 白名单。
- 两者都不给 = 参数错误。

### D5 · 实机 config 与 gitignore 落地（her-memory 仓）
- `config.yaml` 新增 `tasks:`（至少 `default_worker: codex`）与 `workers:` 两段（值由 Fei 认可的档位写入；claude 权限模式默认 `acceptEdits`，要 bypass 由 Fei 在 config 里自己改——代码不做这个决定）。
- `.her/tasks/.gitignore` 追加 `*.brief.md`（brief 含任务上下文，属 runtime 信号不属记忆）。
- `default_worker` 指向不存在的档位：常规模式 WARN + 继续（兼容期），`HER_TASKS_FAIL_LOUD=1` 时抛错（对齐 `bg-task-config.ts:81-84` 现有 fail-loud 语义）。

### D6 · 附属文件生命周期
`.brief.md` 加入任务附属文件清单：retention 清理（`bg-task-retention.ts`）与 reconcile/清扫处枚举 `.pid/.log/.heartbeat/.done` 的地方同步加 `.brief.md`（实现者 grep 全部枚举点，逐处补，报清单）。

## 4. 程序设计（代码形状）

```diff
 packages/her/src/her-core/
+  worker-profile.ts        # NEW ~100-150 行：WorkerProfile 类型 + workers 段解析 + resolveWorkerInvocation()
~  bg-task-config.ts        # MODIFIED：暴露 workers 段（或委托 worker-profile.ts），HerRuntimeConfig + workers
~  bg-task-spawn.ts         # MODIFIED：D4 双模式、白名单接 D2、brief 落盘、record.worker 记档位键
~  task-executor.ts         # MODIFIED：launchTask options + stdinPath?: string → env HER_TASK_STDIN
~  task-runner.mjs          # MODIFIED：HER_TASK_STDIN 存在 → stdio[0] = openSync(path,"r")
~  extension.ts             # MODIFIED：her_task_spawn schema（command 改 Optional、加 brief Optional、description 更新）
 packages/her/test/
+  bg-task-worker.test.ts   # NEW：本卡全部 AC
 her-memory/（独立仓）
~  .her/config.yaml         # tasks + workers 两段
~  .her/tasks/.gitignore    # + *.brief.md
```

关键签名：
```ts
export type WorkerProfile = { argv: string[] };
export function parseWorkers(text: string): Record<string, WorkerProfile>;
export function resolveWorkerInvocation(
  workers: Record<string, WorkerProfile>, name: string,
): { argv: string[] };            // unknown name → throw（列出可用键）
// SpawnBgTaskInput 增量：
//   command?: string[];  brief?: string;   （XOR，见 D4）
// launchTask options 增量： stdinPath?: string
```

## 5. 行为规格（Gherkin，每条 ≥1 acceptance test，严格 TDD 逐条 RED→GREEN）

- **AC1** GIVEN config 定义 `workers.fake`（argv 指向测试用 node 脚本，脚本行为 = 读完 stdin 原样打印）WHEN `spawnBgTask({objective, worker:"fake", brief:"hello ^&\"<多行>"})` THEN 任务达 running；等待 `.done` 后 `exitCode===0`；`.log` 含 brief 全文逐字节原样（引号/`^&`/换行未被解释）。
- **AC2** GIVEN `worker:"nope"` 不在 config WHEN spawn THEN 抛错且错误信息含可用档位键列表；`.her/tasks/` 无新 `.pid` 文件（未 spawn）。
- **AC3** GIVEN `brief` 与 `command` 同给 WHEN spawn THEN 参数错误抛出；两者都缺同理。
- **AC4** GIVEN 裸命令模式 argv[0]=`"python"`（不在 node 默认 + workers 入口内）WHEN spawn THEN 白名单拒绝；GIVEN config 有 `workers.codex`（argv[0]="codex"）WHEN 裸命令 argv[0]="codex" THEN 放行（白名单已并入档位入口）。
- **AC5** GIVEN brief 长度 > 64KB WHEN 档位模式 spawn THEN 正常完成、log 尾部含 brief 末行标记（stdin 无 argv 长度限制）。
- **AC6** GIVEN Windows 下档位 argv[0] 是 `.cmd` 垫片（测试造一个 echo-stdin 的 .cmd）WHEN spawn THEN `resolveWorkerCommand` 走 `cmd.exe /d /s /c` 链路且 stdin 仍连通、log 收到 brief。（POSIX CI 上跳过，`process.platform` 门）
- **AC7** GIVEN 未设 `HER_TASK_STDIN` 的既有裸命令任务 WHEN 跑 G-120…128 全部既有测试 THEN 全绿（stdin 行为回归为 `"ignore"`，零破坏）。
- **AC8** GIVEN retention/清扫路径 WHEN 任务终态后清理 THEN `.brief.md` 与 `.pid/.log` 同批清掉（D6）。
- **JUDGE（验收层亲跑，不进单测）**：实机以真 `codex` 档位 spawn 一个最小 brief（"print OK 后退出"级），`her_task_output` 读到真实输出——网络/额度依赖，由验收方执行并留证据。

## 6. Verification（谓词化，执行方逐条跑，绿灯循环上限 5 轮）

| 命令 | 期望 | 覆盖 |
|---|---|---|
| `cd D:\@Her\Her-repo\samantha; node --import tsx --test packages/her/test/bg-task-worker.test.ts` | exit 0 | AC1-AC8 |
| `node --import tsx --test packages/her/test/bg-task-executor.test.ts packages/her/test/bg-task-g121-g124.test.ts packages/her/test/bg-task-g125.test.ts packages/her/test/bg-task-g128.test.ts packages/her/test/long-task-worktree.test.ts` | exit 0 | AC7 回归 |
| `npx biome check packages/her/src/her-core/worker-profile.ts packages/her/src/her-core/bg-task-spawn.ts packages/her/src/her-core/bg-task-config.ts packages/her/src/her-core/task-executor.ts`（或项目等效 lint） | exit 0 | 风格 |
| `rg -n "gpt-5|claude-|deepseek" packages/her/src/her-core/worker-profile.ts packages/her/src/her-core/bg-task-spawn.ts` | 无输出 | 零硬编码型号 |

## 7. 安全（附录 I 对齐）

- 入口白名单唯一真相源 = config workers（D2）；工具 schema 不暴露 allowlist 覆盖。
- brief 永不进 argv（D1，防 cmd.exe 二次解析注入）。
- brief/log 是 runtime 信号：gitignore、retention 清理、record.md 只存 objective 不存 brief 全文。
- claude 权限模式是 config 决定不是代码决定（D5）。
- worker 无 Her 记忆工具——brief 必须全量自包含（机制文决策②约束 1；spawn 方职责，工具 description 里写明）。
