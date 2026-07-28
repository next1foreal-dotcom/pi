---
name: orchestrate
description: 把一个太大、单次跑不完、或需要并行扇出的任务,变成一支 orchestrator + persistent sidekick 团队——你当 orchestrator(拆解/冻 spec/验证/合成),便宜 worker 子代理执行实现轮;更强的 advisor 只在冷边界审(独立 verifier / 硬冲突 / 终审),绝不常驻热路径。触发:任务大到一次跑不完、需要并行研究/生成多个子任务、Fei 说"编排一个团队"、"fan this out"、"派出去并行做"、"太大了拆开跑"。不适用于单文件小改(~<20 行无架构含义)——那种直接做,别套这套开销。
---

# orchestrate — Orchestrator + persistent sidekick

一个模型是瓶颈;一个大脑 + 一群热缓存的手不是。本 skill 把你变成 **orchestrator**:
冻 spec、派发、验证、合成。实现轮交给更便宜的 **executor sidekick**;贵模型顾问
只在**冷边界**出场——不拿前沿价重读整段 transcript 当「中途顾问」。

**你有别的 harness 没有的地基:her-memory。** 拆解前先 recall 库存(相似任务、踩过的坑、
Fei 的偏好),别派 worker 去重新发明记忆里已有的东西。

> 2026-07-28 改写(Fei「偷」Jason Zhou / Devin Fusion 钱账):默认 Orchestrator,禁 Advisor
> 式烧额度;FIX → 热续聊同一 worker,不默认冷 spawn;advisor 从「两次强制」降为冷审。
> 骨架仍源自 AOW,钱账与热/冷纪律对齐 Fusion + open-agent-teams。

## 角色铁律(最先内化,任何时候不许破)

- **你(orchestrator)拥有热路径**:Frame → Plan → Freeze → Delegate → Verify → Synthesize。
  **你永不亲自干 worker 级的累活**(判断留下,实现派下去)。例外:~<20 行无架构含义
  的修补,派发开销更大——自己改。
- **worker 是 executor sidekick**:首次派发吃完整 brief;之后同任务的 FIX/复审优先
  **热续聊**(同一子代理会话跟一句),吃缓存上下文。禁止「每轮新 spawn 重付上下文税」当默认。
- **advisor 是冷审批评者,永不执行**:不在热路径上。强制位置取消。只在下方「冷边界」
  才准叫。顾问调用吃**新 input**;同一 worker 续聊吃**缓存**——别搞反。

## 模型是旋钮,层级才是持久的部分

三层的**层级**是不变的;每层用哪个具体模型是**配置**,不写死在这份纪律里。

- **advisor**(冷审) = 你能拿到的最强推理档
- **worker / sidekick** = 能过验收的最便宜档
- **orchestrator** = 当前主会话模型(就是你)

型号→层级的映射走 `.pi/agents/*.md` 的 frontmatter。**这份 skill 正文里不出现任何具体型号。**

## 循环(六步热路径;advisor 不在环内)

1. **Frame(定标)**:说清交付物 + **3–5 条可核验的成功标准**。任务太模糊连这个都写不出
   → 只问一个问题,然后停。同时定预算(见下)。
2. **Plan(拆解)**:分解成自包含子任务——输入 inline、各自的验收标准、波次分配(最大化并行)。
3. **Freeze(冻 spec)**:非琐碎活把无歧义 spec 落盘(任务文件夹 / goals / 约定路径),再派发。
   小活可把完整 work order 写进 brief,不强制落盘。
4. **Delegate(派发)**:按 `references/worker-brief.md` 派每一波。brief **必须以**
   `ROLE: EXECUTOR — do the work yourself; do not spawn subagents.` 开头。并行子代理,然后等齐。
5. **Verify(验证)**:每个结果对照**它自己的**验收标准判 **PASS / FIX / ESCALATE**。
6. **Synthesize(合成)**:全部 PASS 后组装交付物。worker 输出之间的冲突**显式裁决,
   绝不取平均**。

可选冷审(环外):计划特别险、或交付物要 ship 前品味/风险审 → 按
`references/advisor-consult.md` 开一次**独立**咨询。不是默认步骤。

## 验证纪律(第 5 步的全部秘密)

- 判词三选一:**PASS** / **FIX**(热续聊并点名具体失败)/ **ESCALATE**。
- **验证必须锤炼交付物本身**:真跑那条命令、真读那份输出。grep 一下 README、测个相邻的
  东西、打印 True 然后退出码 0、确认文件存在——这些什么都证明不了,一律不算验证。
- 绝不静默接受"部分通过";绝不由你亲手修补实质性失败——**热续聊或重派**。
- **FIX 默认热执行**:给**同一个** worker 会话跟一条修复指令(失败标准 + 具体错误)。
  仅当会话已死 / 不可续 / 上下文已毒 → 才冷 spawn 新 brief(见 worker-brief 重派规则)。
- **冷审查另论**:对抗审、跨家族 verifier、独立品味审 → **fresh** 子代理(作者盲区要冷启动)。

## 冷边界(什么时候才准叫 advisor)

只有这些情况才叫 advisor,其余时间它不在热路径上:

- 两个 worker 结果在给定上下文之外互相矛盾
- 同一子任务两次热续聊仍验证失败
- 判断题落在成功标准覆盖范围之外
- 计划必须中途结构性变更
- 你主动选择的一次**可选**计划评审或交付品味终审(预算内,明示「冷审」)

## 预算纪律

Frame 步骤就定死预算,与成功标准一起公示。合理形状:worker 派发/续聊次数 ≈ 子任务数 × 2
(热续聊也计数),advisor 咨询默认 **0**,有硬边界时再开,全任务合计建议 ≤ 3。
**核心不是上限本身,而是超支永不静默**——花完了就停下汇报,或明说"再花多少能换什么"
让 Fei 决定。某个档位不可用时明说并停下问,**不自动顶替**。

## 状态板(每步之后打一行)

每个循环步骤后,每子任务一行:状态(PENDING / DISPATCHED / PASS / FIX / ESCALATED)
+ 派发路径(cold spawn / hot resume)+ 重试数。例:`W2: FIX → PASS | hot resume ×1`。
让 Fei 一眼看清团队在哪、卡在哪。

## 收尾

停在:一个已验证的交付物、耗尽的预算、或一个需要 Fei 的阻塞点。交回:
交付物 + 计划/冻 spec 路径 + 每子任务的验证台账 + 若有 advisor 意见(采纳的和反驳的)
+ 剩余风险。

## 判断与汇报的底线(贯穿全程)

- **证据优先**:任何判断给证据——代码判断给 `file:line` 亲验(不收自述);行业判断给
  一手来源;有分歧的"最优解"多镜头看后综合,不照搬最高分。
- **汇报三问**:根因是什么、改了什么、凭什么证明它是对的(亲跑的命令 + 实际输出)。

---

> 纪律条款融合:AOW harness 无关骨架 · Jason Zhou / Devin Fusion 钱账(orchestrator >
> advisor、persistent sidekick) · Her multi-model-sop「执行会话协议」· 证据优先。
> 模型是旋钮,层级与热/冷纪律才是持久的部分。
