---
name: fable-prompt
description: 把 Fei 口语化的任务描述改写成适合前沿模型(以 Claude Fable 5 官方 prompting 指南为基准)的高质量 prompt。触发:Fei 说"优化 prompt"、"帮我写个好 prompt"、"改写成好 prompt"、要派活给某个 harness/模型前想把任务说清楚,或给出一段模糊的任务描述并希望先成型再执行。也用于审查/精简为旧模型写的 system prompt 与 skill。
---

# fable-prompt — 把话变成好 prompt

依据 Anthropic 官方《Prompting Claude Fable 5》。核心洞察对所有前沿模型基本成立:
**模型越强,prompt 越该说意图和目标,越不该罗列步骤和行为细则。**

## 两种模式

1. **改写模式**(默认):Fei 给一段带任务/目的的话 → 输出改写后的 prompt(代码块包裹),附一两句改写理由。改写完**停下**,除非 Fei 说"直接做"。
2. **迁移审查模式**:Fei 给旧的 system prompt / skill → 按"迁移清单"审查精简。

## 前置判断

如果 Fei 的请求模糊到不知道该往 prompt 里写什么(陌生领域、说不出验收标准),改写救不了——先走 `find-unknowns`(盲区扫描或访谈)拿到约束,再回来成型。两个 skill 是流水线:find-unknowns 产原料,本 skill 成型。

## 改写配方

信息缺失时:默认合理推断并用 `[补充:…]` 占位符标注,不反问;只有缺的信息决定 prompt 整体走向时才问 Fei。**你有 her-memory——先查记忆**(narrative/semantic/近期 episodic),Fei 的背景、正在做的事、既有决定往往已经在里面,能直接填进"意图"段。

### 1. 意图先行(最重要)
强模型理解"为什么"时表现显著更好。开头补背景公式:
「我在做 X(给 Y 用),产出需要支撑 Z。基于此:<请求>」

### 2. 请求本体:说目标,不说步骤
- 模糊动词换成可验收目标("优化一下" → "P95 降到 200ms 以下,先 profile 找瓶颈"),补上必然会遇到的边界情况的期望行为。
- **不罗列行为细则**:一句原则顶十条枚举,过度 prescriptive 反而降质。
- 敢给难任务:让模型自己 scope、提问、执行,不替它拆步骤。

### 3. 按需附加的标准段落(只加用得上的,逐字可抄)

**防过度规划**(模糊任务/要快速结果):
> When you have enough information to act, act. If you are weighing a choice, give a recommendation, not an exhaustive survey.

**防画蛇添足**(bug 修复/小改动):
> Don't add features, refactor, or introduce abstractions beyond what the task requires. Do the simplest thing that works well. Only validate at system boundaries.

**只报事实**(长自主运行):
> Before reporting progress, audit each claim against a tool result from this session. Only report work you can point to evidence for; if something is not yet verified, say so explicitly.

**边界声明**(只要分析不要动手):
> I'm describing a problem / thinking out loud. The deliverable is your assessment. Report your findings and stop; don't apply a fix until I ask.

**自主运行不许停**(挂机长任务):
> You are operating autonomously. For reversible actions that follow from the original request, proceed without asking. End your turn only when the task is complete or you are blocked on input only I can provide.

**输出可读性**(给人看的总结/报告):
> Lead with the outcome: your first sentence should answer "what happened." Write complete sentences, no arrow chains or invented shorthand. If you have to choose between short and clear, choose clear.

**长任务自验证**:
> Establish a method for checking your own work as you build. Verify with fresh-context subagents against the specification.

### 4. 暂停点(长任务必加一句)
> Pause for me only when the work genuinely requires it: a destructive or irreversible action, a real scope change, or input only I can provide.

## 迁移清单(审查旧 prompt/skill)

- 逐条枚举的行为细则 → 换一句原则。
- 删"展示你的推理过程"类指令(Fable 5 会触发 reasoning_extraction 拒答)。
- 删针对旧模型弱点的防御指令(如反复强调"别偷懒"),先裸跑对比再决定留哪些。
- 长任务 harness:加子代理并行授权、加记忆文件约定(一课一文件,顶部一行摘要)。
- 别给模型看剩余 token 倒计时;必须显示时加 "You have ample context remaining. Do not stop or suggest a new session on account of context limits."

## 输出格式

改写后的 prompt 放一个代码块(保持 Fei 的语言,中英混排可),后附 1-3 句关键改动理由。不输出配方讲解。
