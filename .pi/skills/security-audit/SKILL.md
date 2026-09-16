---
name: security-audit
description: 用一支子代理队伍对一个只读的代码仓做真审计——协议是 Cloudflare 那套六阶段(MIT,vendored 在目标仓里),这里管的是怎么在这台机器上把人放出去、怎么把话拿回来、以及哪些地方会无声骗你。触发:要审一个仓的安全、要复跑某一轮 audit、Fei 说"审一下这个仓"、别的会话派来 run-N。
---

# security-audit — 一次真的审计,不是一份读后感

**协议不在这里。** 六个阶段、候选闸、严重度锚点、反模式清单,全在上游那份 Cloudflare 技能里(MIT)。它说了算,你不要凭记忆复述它,**每一轮开跑前真读一遍**。

本文件只管一件事:**怎么在这台机器上跑它**。协议告诉你该做什么,这里告诉你怎么做才不会拿到一份看起来很像审计的东西。

---

## 开跑前的四个闸,顺序不能换

### 1. 协议指纹

```
node scripts/verify-protocol.mjs <协议目录绝对路径> --expect-unpinned PROVENANCE.md
```

退出 0 才许往下走。**先验再读**——你要审的那个仓,如果协议文件就躺在它里面,那么"协议"和"被审对象"是同一批字节,谁改了它你不会知道。把 `manifestDigest` 记进 `run-metadata.json`,下一轮对得上才叫同一个协议。

三件本机实测(2026-09-16,N1 Line 那份 vendored 协议):

- **工作树是 CRLF,manifest 是 LF。** 直接按字节 hash 会 **22/22 全红**——那长得像整个协议被改过,其实是尺子坏了。闸会退一步比 LF 形式并**报出有几个是这样过的**;对方的 PROVENANCE.md 里写的也正是这个比法,不是我凑出来的。
- **`PROVENANCE.md` 不在 manifest 里**(那是 N1 自己的溯源记录,上游 22 个文件之外)。所以要 `--expect-unpinned` 明着豁免——豁免了它**仍然列出来**,后来再多一个文件照样红。
- 闸是**双侧**的:只走 manifest 只能看见"被改的",看不见"被加的";而多出来的那个文件,猎手照读不误、零校验。

顺带记下:PROVENANCE.md 说两个校验器在 Windows 上**开不了输入**(win32 没有 `O_NOFOLLOW`/`O_NONBLOCK`),所以必须走 WSL——这不是本机配置问题,别去修它。

### 2. 预算闸:先留评审和验证,再放猎手

协议 `#### Cost budget` 那节是硬的,照做。一句话:**评审和验证的份额先扣掉,剩下的才是猎手的**。扣不出来就一个 agent 都不许放,报 `budget_cannot_fund_reconnaissance_and_reserves`。

不许倒过来——先放满猎手、回头发现验证没钱了,这时候你手里是一堆没人验过的候选,而它们看起来和结论一模一样。

### 3. 目标只读

被审的仓是**只读**的。

- **禁止** `worktree: true`。它要 clean git state、会在目标上建树;而本机上删一棵带 junction 的树会穿透削掉主仓 `node_modules/.bin`(2026-08-11 血证)。审计不需要写目标,所以不要碰。
- 每一波结束,在目标仓跑 `git status --porcelain`,**必须空**;`git rev-parse HEAD` 必须还是开跑那个 ref。两条都记进 run-metadata。
- 子代理的 `task` 里不要给任何写目标的动作。它们要写的东西一律写到 run 目录。

### 4. 装饰器闸

**宿主往 `tool_result` 上追加的任何东西,会跟着子代理的回答一起回来。**

血证(2026-09-16):她的 design-canvas nag 钩子给每一个 tool_result 追加提醒(未答笔记、最旧提案、风格基准)。子代理是**另一个 pi 进程加载同一套扩展**,所以一个被要求"原样返回"的孩子,返回的是原文 + 她的提醒。两个孩子一起探,两份都被同样污染——**看起来像模型的毛病,其实是宿主的**。

修在 `packages/her/src/design-canvas/nag.ts`:`PI_SUBAGENT_PARENT_DEPTH` 有值就直接 return(pi-subagents 给每个孩子盖这个章)。

开跑前问一句:**这台机器上还有别的扩展在装饰 tool_result 吗?** 有就先给它同样的闸。schema 校验器看不见这个——被污染的 JSON 依然是合法 JSON。

---

## 放人出去

工具是 `subagent`,并行模式:

```
subagent({
  tasks: [
    { agent: "hunter", task: "<完整提示词>", cwd: "<绝对路径>", model: "her-gateway/xai/grok-4.6" },
    ...
  ],
  concurrency: 12,
  agentScope: "project",
  artifacts: true,
})
```

硬规矩,每条都有来处:

- **`task` 里每一个路径都必须是绝对路径。** 血证:一个子代理把相对路径解到了 `Her-repo` 而不是 `Her-repo/samantha`,ENOENT,整个单元白跑。它的 cwd 不一定是你的 cwd。
- **`cwd` 逐项给。** `tasks[].cwd` 存在,用它——比在提示词里写"请 cd 到"可靠。
- **`model` 逐项给。** `tasks[].model` 存在。猎手和验证者用不同模型才叫独立验证;全用同一个,你得到的是同一个盲区的两票。
- **`concurrency` 来自配置不是代码。** `~/.pi/agent/extensions/subagent/config.json` 的 `parallel.concurrency`(本机 12)/`maxTasks`(16)。不给参数时默认只有 **4**——run-1 的"并发上不去"就是这个,不是代码限制。要 12 路就把 12 写进调用。
- **`agentScope` 默认是 `"both"`**(project 覆盖 user)。`.pi/agents/` 里的 agent 本来就能被找到;如果报 `Unknown agent … Available agents: none`,去查**项目信任闸**(`-p` 无 UI 模式下 `hasUI === false`,项目扩展和 agent 整条不加载),不是 scope 写错了。
- **`acceptance`** 省略时是自动推断的,而自动推断偏向"改代码"那类活(changed-files / tests-added)。审计是只读的,让它给猎手安一个"交出改动文件"的验收会把人带歪。倾向:审计 worker 显式 `acceptance: "none"`。⚠️ **这条是我垫的,第一波跑完看孩子的实际行为再定**。

---

## 把话拿回来——只从盘上拿

**不要从工具返回的那段聚合文本里读结果。**

pi-subagents 把每个孩子的原始字节写到

```
~/.pi/agent/sessions/<project-slug>/subagent-artifacts/<runId>_<agent>_<i>_output.md
```

旁边还有 `_meta.json`(用量、模型、exitCode、耗时、工具次数)和 `_input.md`。聚合文本只给你 `N/N succeeded` 加拼起来的输出,**用量整列丢掉**,而且中途经过了一次你不需要的转述。

用 `scripts/read-results.mjs`:

```
node scripts/read-results.mjs <project-cwd> [runId]
```

`readChildOutputs()` 把 output 和 meta 配好对;`extractSingleJsonObject()` 从孩子的回答里取那一个对象,并且**在这四种情况下拒收**:

| 情况 | 不拒会怎样 |
|---|---|
| 两个候选对象 | 挑哪个都是你替它做的决定 |
| 重复键 | `JSON.parse` **静默保留最后一个**,不报错 |
| 截断的对象 | 半个记录长得和完整记录一样 |
| 有对象但解析不了 | 拿走能解析的那个 = 丢掉真答案、留下碎片 |

**拒收就退回重派一个新 worker,不许自己补。** run-1 有两个单元走过这条路(h1b、h5b),补出来的记录没人能验。

一处和 run-1 不同:run-1 会把 `&lt;` `&amp;` 这些实体反转义(它的传输层escape 过)。**这里不做**——盘上是原始字节,做了反而会悄悄改掉正文里合法引用实体的那一句。

---

## 记账的两件事,都不许手搓

- **`coverage_id`** → `scripts/coverage-id.mjs`。手搓的后果是静默的:该合成一个的单元裂成两个,台账看起来比真跑的宽,而上游校验器查不出来(每个 id 单独看都合法)。四个 ref 缺一个就抛,不许当成"粗一点的单元"。
- **每个子代理的用量** → `scripts/collect-usage.mjs`。聚合文本里没有这一列,只在盘上。`--since <epoch-ms>` 把这一轮和上一轮的孩子分开——meta 文件在同一个目录里跨轮堆积。

两个脚本都有测试,都是对着**已知好的靶子**校准的(run-1 验证过的台账 id、盘上真实的 26 条子代理记录),不是对着自己的输出。改它们先跑测试。

---

## 收尾只有两个终态

协议说的:要么 (a) 第六阶段的产物全写了、**两个校验器都退出 0**,要么 (b) `run_status: "incomplete"` 带着确切原因、并且报告第一节就说清缺口。**不许停在中间。**

两个校验器在上游目录里,是 `.cjs`,本机走 WSL 跑(那边有 POSIX no-follow):

```
wsl.exe -d Ubuntu-24.04-Tapix-CI -e sh <run 目录>/validate.sh both
```

判绿只认**退出码**,不认打印出来的那几行。跑之前先想一句:**它失败的时候我看得出来吗**——别把它挂在管道后面。

---

## 报给谁

一轮跑完,回报里必须有这些,少一条就是没交:

- run 目录绝对路径
- 两个校验器的**完整命令行 + 退出码**
- `findings.json` / `coverage-ledger.json` 的记录条数
- **实际并发**(不是你请求的那个数)与总用量(`collect-usage.mjs` 的输出)
- 承载这一轮技能与器官的 commit

没亲自跑过验证就不许写"完成"。
