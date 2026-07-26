# G-129 · Worker 产品包装：外部 CLI 默认工人（claude -p / codex exec）

> **文档类型**: 施工图（设计已定，照做）
> **日期**: 2026-07-26 · 作者: Fable 5（主会话）· **v2**（已折跨家族审 17 条发现，见 §8）
> **上游依据**: `Her-repo/docs/spark/2026-07-26-background-tasks-and-artifacts-mechanism.md` §7 决策②、附录 F.2 / G / I
> **前置**: G-119…128 主环已 DONE（本卡不动 runner 协议与五层机制本身）

---

## 0. 现状（已亲核 file:line，2026-07-26）

| 事实 | 坐标 |
|---|---|
| `her_task_spawn` 工具要求调用方直给 `command` argv；`worker` 只是自由字符串标签 | `packages/her/src/extension.ts:1701-1708` |
| 可执行白名单 = `["node","nodejs"]` + `process.execPath`；**真 CLI（claude/codex）经工具面根本派不出** | `packages/her/src/her-core/bg-task-spawn.ts:23,54-75` |
| `allowExecutables` 是 spawnBgTask 的输入参数（调用方随传随过）；工具 schema 未暴露它 | `bg-task-spawn.ts:31,84` |
| config 有 `tasks:`/`publish:` 两段解析；**无 `workers:` 段**；`default_worker:"cheap_worker"` 无解析逻辑，纯标签 | `bg-task-config.ts:10-60,100-137` |
| Windows `.cmd/.bat` 陷阱部分已解：`.cmd`→`cmd.exe /d /s /c`；但裸名解析有 D7 所述 bug | `task-executor.ts:24-56` |
| runner 把 worker stdin 钉死为 `"ignore"` | `task-runner.mjs:20` |
| 机制文契约：`worker` 必须是 config 档位键，不在 config → 抛错；档位值禁止型号字面量 | 机制文 L895, L1190-1202 |
| 机制文附录 G 的 `workers: {provider, model_ref}` 是**示意**（"仅示意键名形态，具体值不进本文档"）；决策②（外部 CLI）落地后以本文 D3 的 argv 形态为准，机制文由编排方同步更新 | 机制文 L1333-1337 |
| `.her/tasks/.gitignore` 已忽略 `*.pid/log/heartbeat/done`；**无 brief 条目** | `her-memory/.her/tasks/.gitignore` |
| 实机 `her-memory/.her/config.yaml` 尚无 `tasks:`/`workers:` 段（全靠默认值 + WARN）；**不存在旧 provider/model_ref 档位配置**（双 schema 兼容无必要） | 实机文件已读 |
| 实机 `claude`/`codex` 均为 npm 双垫片：无扩展名 **sh 脚本** + `.cmd`（`where.exe` 先返回前者）；claude 2.1.187 / codex-cli 0.144.1 | `where.exe claude` / `where.exe codex` 实测 2026-07-26 |
| 任务枚举按 `.md` 后缀过滤（`name.endsWith(".md")`）——brief 文件名**不得**以 `.md` 结尾 | `bg-task-spawn.ts:263-266`（listBgTasks） |
| 自动重试路径由 reconcile 触发、带 `command` 重建任务——新模式必须与它兼容 | `bg-task-reconcile.ts:196-206` |
| launcher/runner 目前**全量继承 `process.env`**（含 `HER_LLM_API_KEY` 等） | `task-executor.ts:65-68`、`task-runner.mjs:23` |

## 1. 目标（一句话 + 成功画面）

Samantha 说 `her_task_spawn({ objective, worker: "codex", brief: "<全量任务包>" })` 就能把活派给**真外部 CLI**；档位在 `config.yaml` 定义（零硬编码型号），唤醒后 `her_task_output` 读到真 CLI 的输出。

## 2. Non-goals（本卡明确不做）

- 不做 `cursor-agent` 档位（装好后 config 加一段即可——**验收标准之一：加新 worker = 只改 config**）。
- 不改 runner 的 sentinel/heartbeat/杀树协议；不动 pi 上游包。
- 不做 worker 结构化回报解析（brief 里要求 worker 落盘产物；父环靠句柄分页读 log）。
- 不做真实 token 用量解析/计价（D8 先保守结算，真实用量解析 = 后续卡）。
- 不做敏感 brief 审批流（Telegram 确认流是现成积木，另卡接）。
- 不修 `her_task_output` 分页脱敏的跨 chunk 边界问题（G-121 既有债，记 BACKLOG 欠账，不在本卡写集）。

## 3. 设计决策（已定，偏离需回 Fable 重拍）

### D1 · brief 经 stdin，不经 argv；文件名 `<id>.brief`（无 .md 后缀）
`brief` 落盘为 `.her/tasks/<id>.brief`（**不带 `.md`**——任务枚举按 `.md` 过滤，带了会被当任务记录解析，全链路中断），runner 把该文件以只读 fd 接到 worker 的 stdin。理由（三合一）：
1. `.cmd` 垫片路径走 `cmd.exe /d /s /c`，argv 里的引号/`^`/`&`/换行会被 cmd 二次解析——注入面（附录 I）；
2. Windows 命令行 ~32KB 上限，真任务包轻松超；
3. `codex exec -` 与 `claude -p`（无 prompt 位置参数时）**都原生从 stdin 读 prompt**——零适配。

落盘前处理：
- **过 `redactSecrets`**（`store.ts` 现成函数）再写盘；
- **字节上限**：`tasks.brief_cap_bytes`（默认 1_048_576），超限抛错、不落盘不 spawn；
- UTF-8 无 BOM。

传递：launcher 设 `HER_TASK_STDIN=<briefPath>`；runner 检测到该 env 时 `openSync(path,"r")` 作 stdio[0]，否则维持 `"ignore"`。`HER_TASK_STDIN` 指向的文件不存在 → runner 写 `.done`（`exitCode:-1, detail:"brief_missing"`），不裸崩。

### D2 · 白名单收敛到 config；`allowExecutables` 整个移除
- allowlist = `DEFAULT_ALLOW(node/nodejs)` + `process.execPath` + **workers 档位各 `argv[0]`**。
- **`allowExecutables` 从 `SpawnBgTaskInput` 删除**（公开输入即绕过面；测试改用注入 workers 档位的 config fixture，不留运行时后门）。
- **裸命令模式收紧**：`argv[0]` 只许**裸名**（含 `/` 或 `\` 的路径一律拒绝——防"同 basename 恶意路径"绕过；档位模式的 config argv 是 Fei 手写的信任输入，不受此限）；且裸命令解析若落到 `.cmd/.bat`（即将进入 `cmd.exe` 二次解析链）→ **拒绝**，报错提示"请用 worker 档位派 CLI"。ComSpec 链路只对档位模式开放（档位 argv 是静态配置，brief 走 stdin，无模型可控字符串进 cmd.exe）。
- `worker` 名不在 config → 抛错（错误信息列可用档位键），不 spawn 任何进程。

### D3 · worker 档位 schema（config.yaml）
```yaml
workers:
  codex:
    argv: ["codex", "exec", "--sandbox", "workspace-write", "-m", "gpt-5.6-terra", "-c", "model_reasoning_effort=high", "-"]
    env_allow: []          # 可选：额外放行给 worker 的环境变量名（不是值）
  claude:
    argv: ["claude", "-p", "--permission-mode", "acceptEdits"]
```
- 字段：`argv: string[]`（必填）+ `env_allow: string[]`（可选，默认空）。prompt 一律 stdin（YAGNI：将来有 CLI 必须 argv 传 prompt 再加字段）。
- 型号/effort/沙箱旗标全部活在 config——代码里**零型号字面量**。
- **fail-loud**：`workers.<name>` 存在但形状非法（argv 缺失/非字符串数组/空）→ `resolveWorkerInvocation` **抛错**，不静默回退默认（区别于"整段缺失"的 WARN+默认兼容语义）。
- 机制文附录 G 的 `{provider, model_ref}` 示意形态由本 schema 取代（§0 已核实机无旧配置，不做双 schema）；机制文更新由编排方在验收时完成，执行方不碰 Her-repo。

### D4 · 两种 spawn 模式，判定规则显式
- **档位模式**：给了 `brief` → 走档位；`worker` 缺省 = `tasks.default_worker`；`command` 不许同给（同给抛参数错）。
- **裸命令模式**：给了 `command` 且无 `brief` → 原语义（G-120…128 兼容），**完全不解析 workers/default_worker**（既有 fixture 无 workers 段、default_worker 仍是 cheap_worker 时必须照常工作）。
- 两者都缺 → 参数错误。校验全部在 `spawnBgTask` 入口，失败=抛错，**不产生任何 .md/.pid 文件**。
- **record frontmatter 新增 `mode: worker | command`**；档位模式 `worker` 字段记档位键。契约文档（Her-repo `her-core/docs/task-record-schema.md`）由编排方验收时同步，执行方不碰。

### D5 · 实机 config 与 gitignore 落地（her-memory 仓，**编排方做**，不在执行方写集）
- `config.yaml` 新增 `tasks:`（`default_worker` + `brief_cap_bytes`）与 `workers:` 两段。
- `.her/tasks/.gitignore` 追加 `*.brief`。
- `default_worker` 指向不存在的档位：档位模式 spawn 时抛错；`HER_TASKS_FAIL_LOUD=1` 时 loadRuntimeConfig 即抛。

### D6 · 附属文件生命周期 + 重试兼容
- `.brief` 加入任务附属文件清单：**终态时不删**（重试要用），随 retention（`bg-task-retention.ts`）与 `.pid/.log` 同批清理；执行方 grep 全部枚举 `.pid/.log/.heartbeat/.done` 的地方逐处核对是否需加 `.brief`，报清单。
- **自动重试**（`bg-task-reconcile.ts:196-206`）按 `mode` 分派：`mode:worker` → 用 `worker` 档位 + **既存 `.brief` 文件**重建（新任务 id 的 brief 从父任务 brief 复制或直接引用父路径——实现者选，测试钉"重试后 worker 仍从 stdin 收到原 brief"）；`mode:command` → 现行为不变。

### D7 · 修 `resolveWorkerCommand` 的 npm 垫片 bug（本卡范围内的既有 bug）
现逻辑 `candidates.find(c => !/\.(cmd|bat)$/i.test(c))` 会选中 `where.exe` 返回的**无扩展名 sh 脚本**（npm 给 Git Bash 用的）直接 spawn——Windows 上非 PE 文件，必失败。修法：非 cmd 候选必须限定 **`.exe`/`.com`**；无则回落 `.cmd` → `cmd.exe /d /s /c`。裸名解析优先级：`.exe/.com` > `.cmd`(经 ComSpec，仅档位模式) > 其余候选忽略。

### D8 · 费用保守结算（不再让预算闸门空转）
终态对账（reconcile 处理 completed/failed/cancelled）时：向 `cost-ledger` **追加一条 = `budgetReserved`**（字段标注 `estimate: "reserved-cap"`），使 `budget_daily_cap` 真实累计（方向性保守：宁可多计不可漏计）。真实用量解析（claude JSON usage / codex "tokens used"）= 后续卡，本卡不做。幂等：同一任务只结算一次（record 记 `costSettledAt`）。

### D9 · worker 环境最小化（不再全量继承 env）
档位模式下 launcher 构造 worker env = **基础白名单**（`SystemRoot/ComSpec/PATH/PATHEXT/APPDATA/LOCALAPPDATA/USERPROFILE/HOMEDRIVE/HOMEPATH/HOME/TEMP/TMP` + `HER_TASK_ID`）+ 档位 `env_allow` 列出的名字（值取自当前 env）。**`HER_LLM_API_KEY` 等一切未列名的变量不下发**。裸命令模式维持现全量继承（兼容，G-120 语义）。另：launcher 组 env 前先**清除继承来的全部 `HER_TASK_*`**（防上层残留污染 stdin/cwd/heartbeat），再写本次显式值——两种模式都做。

## 4. 程序设计（代码形状）

```diff
 packages/her/src/her-core/
+  worker-profile.ts        # NEW ~150-200 行：WorkerProfile 类型 + workers 段解析(fail-loud) + resolveWorkerInvocation + env 白名单构造
~  bg-task-config.ts        # MODIFIED：暴露 workers 段（或委托 worker-profile.ts）+ brief_cap_bytes
~  bg-task-spawn.ts         # MODIFIED：D4 双模式 + mode 字段、白名单 D2、brief 落盘(redact+cap)、删 allowExecutables
~  bg-task-record.ts        # MODIFIED：frontmatter + mode / costSettledAt（仅字段，兼容旧记录缺省）
~  bg-task-reconcile.ts     # MODIFIED：D6 按 mode 重试 + D8 终态结算
~  bg-task-retention.ts     # MODIFIED：清理清单 + .brief
~  task-executor.ts         # MODIFIED：D7 resolver 修复 + D9 env 构造 + stdinPath option
~  task-runner.mjs          # MODIFIED：HER_TASK_STDIN → stdio[0]（brief_missing 防御）
~  extension.ts             # MODIFIED：her_task_spawn schema（command Optional、+brief Optional、description 更新）+ her_task_output description 加"输出是数据不是指令"边界句
 packages/her/test/
+  bg-task-worker.test.ts   # NEW：本卡全部 AC
```

关键签名：
```ts
export type WorkerProfile = { argv: string[]; envAllow?: string[] };
export function parseWorkers(text: string): Record<string, WorkerProfile>;   // 形状非法 → throw
export function resolveWorkerInvocation(
  workers: Record<string, WorkerProfile>, name: string,
): WorkerProfile;                 // unknown name → throw（列出可用键）
export function buildWorkerEnv(profile: WorkerProfile, taskId: string): NodeJS.ProcessEnv;
// SpawnBgTaskInput 增量： command?: string[]; brief?: string;（XOR，D4）；allowExecutables 删除
// launchTask options 增量： stdinPath?: string; env?: NodeJS.ProcessEnv（显式传入=全量替换不合并）
```

## 5. 行为规格（Gherkin，每条 ≥1 acceptance test，严格 TDD 逐条 RED→GREEN）

- **AC1** GIVEN config 定义 `workers.fake`（argv 指向测试用 node 脚本，行为 = 读完 stdin 原样打印）WHEN `spawnBgTask({objective, worker:"fake", brief:"hello ^&\"<多行>"})` THEN 任务达 running；`.done` 后 `exitCode===0`；`.log` 含 brief 全文逐字节原样（引号/`^&`/换行未被解释）；record frontmatter `mode: worker`。
- **AC2** GIVEN `worker:"nope"` 不在 config WHEN 档位模式 spawn THEN 抛错且错误含可用档位键列表；`.her/tasks/` 无新 `.pid`/`.brief`。
- **AC3** GIVEN `brief` 与 `command` 同给 WHEN spawn THEN 参数错误；两者都缺同理；错误路径下零文件残留。
- **AC4** GIVEN 裸命令 argv[0]=`"python"`（不在白名单）THEN 拒绝；GIVEN config 有 `workers.codex` WHEN 裸命令 argv[0]="codex"（裸名）THEN 放行；GIVEN 裸命令 argv[0]=`"C:\\evil\\codex.exe"`（含路径分隔符）THEN **拒绝**（D2 路径禁令）。
- **AC5** GIVEN brief 长度 > 64KB 且 < cap WHEN 档位模式 spawn THEN 正常完成、log 尾含 brief 末行标记；GIVEN brief 字节数 > `brief_cap_bytes` THEN 抛错、不落盘不 spawn。
- **AC6** GIVEN Windows 下档位 argv[0] 是 `.cmd` 垫片（测试造一个 echo-stdin 的 .cmd，**放在带空格的目录路径下**）WHEN spawn THEN 走 `cmd.exe /d /s /c` 链路、stdin 连通、log 收到含特殊字符的 brief 原文。（POSIX 显式 `t.skip`）
- **AC7** GIVEN 未设 `HER_TASK_STDIN` 的既有裸命令任务 WHEN 跑 G-120…128 全部既有测试 THEN 全绿（零破坏；含"无 workers 段 + default_worker=cheap_worker"的旧 fixture 照常工作）。
- **AC8** GIVEN 终态任务超过 `retention_days` WHEN retention 清理 THEN `.brief` 与 `.pid/.log` 同批清掉；GIVEN 任务刚到终态（未过期）THEN `.brief` **仍在**（重试可用）。
- **AC9** GIVEN 候选列表 `[无扩展名文件, x.cmd]`（npm 垫片布局）WHEN `resolveWorkerCommand` THEN 选 `cmd.exe /d /s /c x.cmd`，不 spawn 无扩展名文件；GIVEN 候选含 `x.exe` THEN 直选 `x.exe`（D7；可注入候选或 mock where，行为钉死）。
- **AC10** GIVEN 档位无 `env_allow`、当前进程 env 含 `HER_LLM_API_KEY=秘密` WHEN 档位模式 spawn（worker 脚本 = 打印自己的 env 键列表）THEN worker env **无** `HER_LLM_API_KEY`、有 `PATH` 与 `HER_TASK_ID`；GIVEN `env_allow: ["FOO"]` 且 env 有 FOO THEN worker 看得到 FOO。
- **AC11** GIVEN `mode:worker` 任务以可重试原因失败（orphaned/never_started）WHEN reconcile 自动重试 THEN 新任务成功 spawn 且 worker 从 stdin 收到**原 brief 内容**；`mode:command` 任务重试行为与现测试一致。
- **AC12** GIVEN 任务到终态 WHEN reconcile 处理 THEN cost-ledger 追加一条金额 = `budgetReserved` 的记录（标 estimate）；再次 reconcile **不**重复追加（幂等）。
- **AC13** GIVEN launcher 进程 env 残留 `HER_TASK_STDIN`/`HER_TASK_CWD`/`HER_TASK_HEARTBEAT_MS` WHEN spawn 一个裸命令任务（不带 worktree/brief）THEN worker 的 stdin 为 ignore、cwd=taskDir、心跳按 config——残留值未泄漏（D9 清除）。
- **AC14** GIVEN brief 内容含形如 API key 的片段 WHEN 落盘 THEN `.brief` 文件中该片段已被 `redactSecrets` 处理。
- **JUDGE（验收层亲跑，不进单测）**：实机以真 `codex` 档位 spawn 最小 brief（"print OK 后退出"级），`her_task_output` 读到真实输出——验收方执行留证据。

## 6. Verification（谓词化，执行方逐条跑，绿灯循环上限 5 轮）

| # | 命令（cwd = 仓根） | 期望 | 覆盖 |
|---|---|---|---|
| V1 | `node --import tsx --test packages/her/test/bg-task-worker.test.ts` | exit 0 | AC1-AC14 |
| V2 | `node --import tsx --test packages/her/test/bg-task-executor.test.ts packages/her/test/bg-task-g121-g124.test.ts packages/her/test/bg-task-g125.test.ts packages/her/test/bg-task-g128.test.ts packages/her/test/long-task-worktree.test.ts` | exit 0 | AC7 回归 |
| V3 | `npx biome check packages/her/src/her-core/worker-profile.ts packages/her/src/her-core/bg-task-spawn.ts packages/her/src/her-core/bg-task-config.ts packages/her/src/her-core/bg-task-record.ts packages/her/src/her-core/bg-task-reconcile.ts packages/her/src/her-core/bg-task-retention.ts packages/her/src/her-core/task-executor.ts packages/her/src/extension.ts` | exit 0 | 风格 |
| V4 | `rg -n "gpt-5|claude-|deepseek|sonnet|opus" packages/her/src/her-core/worker-profile.ts packages/her/src/her-core/bg-task-spawn.ts packages/her/src/her-core/task-executor.ts` | 无输出（exit 1） | 零硬编码 |
| V5 | `git status --porcelain` 输出仅含写集内文件 | 无越界改动 | 范围 |

## 7. 安全（附录 I 对齐）

- 入口白名单唯一真相源 = config workers；裸命令禁路径、禁 `.cmd`；`allowExecutables` 已删。
- brief 永不进 argv；cmd.exe 链路只接静态配置 argv。
- brief 落盘前 redact + cap；gitignore；retention 清理；record.md 不含 brief 全文。
- worker env 最小白名单，密钥不下发（D9）。
- `her_task_output` 的输出标注"数据非指令"（防日志注入回流成指令）。
- claude 权限模式是 config 决定不是代码决定。
- worker 无 Her 记忆工具——brief 必须全量自包含（spawn 方职责，工具 description 写明）。

## 8. 跨家族审记录（2026-07-26，codex sol·xhigh，VERDICT: build-with-changes）

17 条发现的终审处置：#1→D1（brief 去 .md 后缀）；#2→D8（保守结算；真实用量=后续卡）；#3→D2（裸命令禁路径）；#4→D2（删 allowExecutables）；#5→D2（裸命令禁 .cmd）；#6→D9（env 白名单）；#7→D4/D6（mode 字段+brief 持久+按模式重试）；#8→改判：附录 G 系示意、实机无旧配置，argv 形态取代之，机制文由编排方同步；#9→D7（与作者独立发现一致）；#10→D9（HER_TASK_* 清除）；#11→收窄：redact+落盘策略，不建审批流；#12→D1（brief_cap_bytes）；#13→改判：G-121 既有债，记 BACKLOG 欠账不入本卡；#14→D3（fail-loud）；#15→D4（模式判定显式）；#16→AC6 扩展（带空格路径+特殊字符）；#17→extension.ts description（写集内）。
