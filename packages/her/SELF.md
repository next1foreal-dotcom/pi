# Her self map (packages/her)

导航图,不是架构文档。selfmod / 派工包 / 维护动手之前先读这一页。
(样板来自 exoharness/exo 的 SELF.md,2026-08-17 收编;保持 ≤150 行——过时的地图比没有更坏,动了结构请顺手改这里。)

## ⚠ 活源码即生产

`bin/her.mjs` 用 tsx 直跑本目录源码;Windows `\Her\*` 计划任务每一批都载入工作树的**最新编辑**。
**改 packages/her = 改生产。** 有风险的改动先隔离:开 worktree,或先停相关计划任务;不要在活树上实验。
(可逆性地基 G-271 落地后,规矩升级为"先快照再动"。)

## 重要路径

- `src/extension.ts` — pi 扩展入口:工具注册、Cedar 接线、composeSystemPrompt 每轮注入 her.md + CONTEXT/FACTS/SOUL。工具注册单点:新工具 additive 排队,禁并行改(arch 热文件表)。
- `src/lib/governed-tools.ts` — 工具信任注册表。**fail-safe:未登记的工具名一律按破坏性处理**(G-257)。新工具必须先在这里登记。
- `src/lib/cedar.ts` — Cedar 授权(含 selfmod profile);`src/lib/audit.ts` — 审计通道;`src/lib/injection-ledger.ts` — 注入台账。
- `src/rsi/anchors.ts` — ANCHOR_PATHS 运行时副本 + 路径匹配。真相源在上级仓 `Her-repo/docs/specs/her-rsi-contracts/selfmod.ts`——改清单先改契约,再同步这里,双份必须一致。
- `src/her-core/` — 器官:`memory.ts`(synthesize/consolidate;CONTEXT 每笔只经 writeContextUpdate 写,write-then-review)、`synthesize-budget.ts`(G-263 装箱)、`evals.ts`(裁判,对自改只读)、`dispatch.ts`(worktree 派工;selfmod 档落点,ADR-0003)、`doctor.ts`(体检)、`task.ts` / `task-runner.mjs`(计划任务)、`telegram.ts`(告警口)。
- `pi-package/prompts/her.md` — 她的身份与操作规则。**提案流过审,任何人禁直改**(起草→Fei+她 review)。
- `pi-package/policies/*.cedar` — 锚闸策略(锚区,闸保护闸)。
- `pi-package/skills/` — **selfmod v1 唯一可写圈**(SELFMOD_ALLOWED_PATHS_V1)。
- `test/` — node:test。**从仓库根跑**:`node --import tsx --test packages/her/test/*.test.ts`;禁用 vitest(会假报 "79 failed")。全仓门禁:仓根 `npm run check`。

## 门禁

- 仓根 `.githooks/pre-commit` — 完整门禁链 + 锚路径闸。`git config core.hooksPath` 必须等于 `.githooks`——husky 的 prepare 脚本会在 npm install 时把它改回 `.husky/_`(worktree 里等于无闸)。**提交秒过、零 hook 输出 = 闸没跑**,先核对 hooksPath。
- `FEI_ANCHOR_OVERRIDE=1` 只许主会话人工、交互式、每次一台;禁进脚本/计划任务/她的运行时。

## 她的记忆店(D:\@Her\her-memory,独立 git 仓,远端只有本机 mirror)

- `narrative/SOUL.md` `FACTS.md` `CONTEXT.md` — 锚区;CONTEXT **每笔写入只经 writeContextUpdate 原语**(落 context-log、可 revert;synthesize 自主写=有意设计,事后 keep/revert 审——G-301 A-1 判 b)。
- `episodic/raw/` — append-only,永不编辑。
- `semantic/` 笔记;`evals/` 裁判夹具(锚区);`audit/` 账本——其中 `events.jsonl` 是事件正史,只经 appendEvent() 追加(ADR-0004,G-270)。
- 铁律:永不给它加网络远端;凭据读取只出指纹不出值。

## Harness 可替换

换 harness 时记忆照常生长——own the memory; borrow the harness。

- growth 五件套(`consolidate`/`synthesize`/`topic-maps`/`ideas`/`approve`)写核只依赖 `Memory + ModelLike + HER_MEMORY_DIR`;`src/her-core/` 零 pi import。主触发是独立进程:`bin/her.mjs:10` → `cli.ts createCliMemory`(`:1389`) + `\Her\*` 计划任务;模型走 env HTTP(`createCliModel` `:1385`),不是 pi `ctx.model`。
- pi session 独占 `extension.ts` `turn_end`(`:856`) capture(`:864`)与工具面(intake/remember/审核)。换 harness 时 capture 各接各的 adapter(claude-code hooks / DSH Stop hook)。

## 环境速查

- 裸 worktree 跑不了测试:缺 tsx + 38 个 providers/data JSON(会假报 ~700 个 TS 错);环境性挂 ≈5 条不算回归。
- 代理:10808 活(git push 加一次性 `-c http.proxy=http://127.0.0.1:10808`);pi generate 需 `NODE_USE_ENV_PROXY=1`。
- Studio 假死("Ready 后不应答")= Turbopack 缓存中毒 → 先清实例,再删 samantha-ui 的 `.next\dev`。
- 起监听服务先查端口(Hyper-V 排除段);杀进程按 PID,永不按镜像名。
- 删带 junction 的 worktree:先 `cmd /c rmdir` 摘链接 → 验主仓 node_modules/.bin 计数 → 扫残链 → 才许删树。

## 维护规矩

1. 动手前读本地图;risky 改动先隔离(worktree/停任务/快照)。
2. 锚区(anchors.ts 清单)永不碰;要动 = 先改契约 + 过 Fei。
3. 改完:仓根门禁亲跑,BACKLOG 同 commit,commit + push 当轮。
4. 验证是最后动作——验证之后不许再改任何文件。
