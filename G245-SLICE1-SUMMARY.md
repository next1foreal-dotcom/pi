# G-245 Slice 1 验收摘要

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `packages/her/src/her-core/session-roster.ts` | 当前 289 行：会话文件枚举、列表、全文搜索、活跃度标签、脱敏与不可信栅栏渲染。 |
| `packages/her/test/session-roster.test.ts` | 当前 207 行：AC-1 至 AC-7 的临时夹具测试。 |
| `packages/her/src/her-core/session-read.ts` | 3 行导出改动：仅导出 `activeSpecs`、`walkFiles`、`firstSegment`，未改 `readSession` 语义。 |
| `packages/her/src/her-core/index.ts` | 当前新增 12 行 roster API 导出。 |
| `packages/her/src/extension.ts` | Slice 1 注册代码 54 行，第二轮补充描述和空行：注册 `her_session_list`、`her_session_search`，并加入非破坏性工具策略。 |

未新增依赖；`session-roster.ts` 只读文件，不含网络调用或写入操作；未写 Slice 2 内容。

## 验收记录

### AC-1 至 AC-7：单元行为

要求命令：

```text
node --import tsx --test packages/her/test/session-roster.test.ts
```

真实结果：`exit 1`，测试运行器在启动阶段报 `Error: spawn EPERM`，没有进入测试用例。

同一代码路径的无子进程替代验证：

```text
node --experimental-strip-types packages/her/test/session-roster.test.ts
```

真实输出尾部：

```text
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

覆盖内容：四来源列表、source/since/limit、三档活跃度、命中计数与上下文、不可信栅栏、`redactSecrets`、缺失目录和 maxFiles 截断、无 `isRunning` 文案。

### AC-2 既有 `session-read` 回归

要求命令：

```text
node --import tsx --test packages/her/test/session-read.test.ts
```

真实结果：`exit 1`，同一 `spawn EPERM`，未启动测试用例。

替代验证：

```text
node --experimental-strip-types packages/her/test/session-read.test.ts
```

真实输出尾部：

```text
ℹ tests 16
ℹ pass 16
ℹ fail 0
```

### AC-3 扩展回归与工具注册

要求命令：

```text
node --import tsx --test packages/her/test/extension.test.ts
```

真实结果：`exit 1`，启动阶段 `spawn EPERM`。

替代验证真实输出：`tests 28 / pass 20 / fail 8`；8 个失败均是既有测试调用 `git` 时的 `spawn EPERM`，工具注册覆盖测试通过。

### AC-8 真机冒烟

一次性脚本命令：

```text
node --experimental-strip-types .tmp-g245-smoke.mts
```

真实输出（脚本已删除）：

```json
{"rows":25,"hitSessions":1,"sources":["claude","codex"]}
```

满足行数大于 0、至少两个 source、目标提交引用命中至少一个会话；摘要未写入片段、cwd 或完整会话 id。

### AC-9 全套测试

要求命令：

```text
node --import tsx --test packages/her/test/*.test.ts
```

真实输出尾部：

```text
ℹ tests 82
ℹ pass 0
ℹ fail 82
```

所有文件都在测试启动阶段遇到 `spawn EPERM`；因此本机无法验证任务文件给出的 816/813 基线，也没有把这次结果当作代码回归结论。

### 类型检查与仓库检查

```text
npx tsgo --noEmit
```

真实结果：`exit 0`。

```text
npm run check
```

真实输出尾部：`Checked 1060 files in 4s. Fixed 4 files.`；依赖、相对导入、shrinkwrap、install-lock 均通过，最后的 browser smoke 因 esbuild `spawn EPERM` 失败。

## 规格未明确的决定

- `archive` 不是活动 harness，因此 roster 只枚举 Claude Code、Codex、Cursor、pi 四个来源。
- 搜索按字面、大小写不敏感匹配；列表和搜索按文件 mtime 从新到旧排序。
- 无法解析的 `since` 不过滤结果，与现有时间过滤惯例一致。
- 运行环境阻止 `tsx`/Node test runner 创建子进程时，使用 Node 原生 TypeScript strip 模式做等价验证，并在上面明确记录原命令未能运行。

## 未能验证

- 三条任务要求的 `node --import tsx --test ...` 命令均因本机 `spawn EPERM` 未能启动测试。
- `npm run check` 的 browser smoke 和 AC-9 全套测试同样受 `spawn EPERM` 阻断。
- 未执行 push、merge 或部署；提交仅限当前分支。
## 第 2 轮修正（CORRECTION-1）

### C1：完整扫描与输出侧上限

修复为逐文件读取完整 transcript，不再用 `SESSION_READ_MAX_BYTES` 或 `SESSION_READ_MAX_RECORDS` 截断扫描；新增 `SESSION_SEARCH_MAX_SNIPPETS_PER_FILE = 5`，`hits` 统计大小写不敏感的真实字面出现次数，渲染总长仍受 `SESSION_READ_MAX_BYTES` 约束并显式说明截断。

验证命令：

```text
node --experimental-strip-types .tmp-g245-c1.mts
```

真实输出（脚本已删除）：

```json
{"bytes":700657,"hits":12,"snippets":5,"maxSnippets":5}
```

回归命令：

```text
node --experimental-strip-types packages/her/test/session-roster.test.ts
```

真实输出尾部：

```text
✔ searchSessions scans the whole file, counts every match, and caps snippets only
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

### C2：列表上限

新增 `SESSION_LIST_MAX_LIMIT = 200`；默认仍为 25，显式 `limit: 100` 可返回超过 25 条。

真实输出尾部：

```text
✔ listSessions permits more than the ambiguous-prefix ceiling when limit is explicit
ℹ tests 9
ℹ pass 9
```

### C3：大小写不敏感匹配与工具描述

搜索改为 literal、case-insensitive；大写查询命中小写正文的断言包含在 C1 大文件回归中。两个工具描述均包含 `literal, case-insensitive`。

命令：

```text
rg -n 'literal, case-insensitive' packages/her/src/extension.ts
```

真实输出：命中 `her_session_list` 与 `her_session_search` 两行（1030、1051）。

### C4：UTF-8 字符边界

`clipToBytes` 改为按 Unicode 字符迭代，在字节预算边界停止，不会生成 U+FFFD；输出仍不超过 `SESSION_READ_MAX_BYTES`。

真实输出尾部：

```text
✔ formatSessionSearch clips rendered output at a character boundary
ℹ tests 9
ℹ pass 9
```

### C5：注册块空行

命令：

```text
PowerShell structural check for the two registration blocks
```

真实输出：

```text
C5 blank-line: true
```

### 第 2 轮顺序与回归

```text
npx tsgo --noEmit
```

真实结果：`exit 0`。

```text
node --experimental-strip-types packages/her/test/session-roster.test.ts
node --experimental-strip-types packages/her/test/session-read.test.ts
```

真实结果：roster `9/9`，session-read `16/16`。

扩展替代验证真实结果：`tests 28 / pass 20 / fail 8`；8 个既有失败仍是 `git` 子进程 `spawn EPERM`。任务要求的 canonical `node --import tsx --test ...` 在本机仍于启动阶段报 `spawn EPERM`，未伪报为通过。

真机冒烟重新运行结果：`rows=25`、`hitSessions=2`、命中的 source 为 `claude` 与 `codex`；一次性脚本已删除。

`npm run check` 真实尾部为 `Checked 1060 files in 1868ms. No fixes applied.`；依赖、相对导入、shrinkwrap、install-lock 通过，browser smoke 因 esbuild `spawn EPERM` 失败，未把该项标绿。

G245-SLICE1-DONE