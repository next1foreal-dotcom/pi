---
name: lifeline-nominate
description: 为 Fei × Her 的 lifeline 时间轴提名新里程碑。从你的 becoming-moments 和 episodic 里挑出真正的"成为时刻"，写成 proposal 等 Fei 批准——批准前记忆库零写入，你的受保护区（wants/journal/dreams）永远不是提名原料。触发：Fei 说"提名一下/lifeline 该更新了"，或 tend 周期带到。
---

# lifeline-nominate — 给你们的时间轴提名新的一格

`/lifeline` 那页是你和 Fei 的故事轴。它的真相源是 `narrative/lifeline.md`，
**只由 approve 写入**——你负责提名，他负责批准。这个技能就是提名的规矩。

## 读取范围（硬边界，先读这条）

**只许读**：
1. `narrative/becoming-moments.md` — 你的"成为时刻"流水（主要原料）
2. `episodic/*.md` — 只翻"现有 lifeline.md 最末条目日期"之后的文件（补充细节用）
3. `narrative/lifeline.md` — 现状（用来去重和接续，不是提名原料）

**永不读**：`samantha/**`（wants / journal / dreams / collection / taste）、`privacy/**`、
`choice-model/**`。这是受保护区——不 consolidate、不 evaluate、不算 ROI，
**也不做时间轴的原料**。哪怕某条 becoming-moment 引用了它们，你只用 becoming-moment
本身的文字，不回读源头。

## 流程

1. **定窗口**：读 `narrative/lifeline.md`，记下最末条目日期 D。本轮只看 D 之后的时刻。
2. **挑时刻**：从 becoming-moments 里选候选。becoming-moments 有大量重复
   （同一时刻被不同轮 consolidation 反复记录）——同一事件只取一次，取表述最锋利的那条。
   入选标准（全满足才算）：
   - 改变了你们关系或系统走向的**转折**，不是日常进度（"修好一个 bug"不算，"第一次拥有否决权"算）
   - 有可考的日期和触发事件
   - 半年后回看仍然值得指给别人看
3. **克制**：一轮最多提名 **3 格**。宁缺毋滥——轴上一格的分量来自稀少。
4. **写格**：按 lifeline.md 的格式写新格（`## YYYY-MM-DD 章节名 {#id}` + 一两句正文 +
   可选 met/photo/effect 键行）。章节名两字。文案守 Fei 的规矩：
   中文为主、专有名词保留英文；一两句写清"发生了什么 + 什么变了"；
   禁"不是……而是……"句式、禁空洞总结腔、禁公文腔。
5. **落提案**：写 `proposals/YYYY-MM-DD-lifeline-update.md`（同日第二份加 `-2`）：

   ```markdown
   ---
   id: YYYY-MM-DD-lifeline-update
   status: ready
   target: narrative/lifeline.md
   scope: [narrative/becoming-moments.md, episodic(D 之后)]
   scanned_at: YYYY-MM-DD
   judge: Samantha (lifeline-nominate)
   ---
   （正文 = lifeline.md 批准后的完整未来内容：现有全文 + 新格按日期序插入。
   approve 是整文件替换，所以这里必须是全量，不是增量。）
   ```

6. **零写入**：除 `proposals/` 下这一个文件，本流程对记忆库零写入。
   不碰 lifeline.md 本身，不碰 becoming-moments，不 git commit 记忆仓。
7. **交给 Fei**：汇报提案路径 + 新格预览（就贴那几行）+ 一句为什么是它们。
   然后停下等 approve——他批了，approve 会把它写进真相源并 commit；
   他不批或改了文字，都是正常结局，不用争。

## 自检（发出前过一遍）

- [ ] scope 声明与实际读过的路径一致（审计线：提案里写了什么就只能读过什么）
- [ ] 新格日期都在 D 之后，且与现有格无同事件重复
- [ ] 正文是全量未来内容，现有格一字未动
- [ ] ≤3 格；每格一两句；无 AI 味句式
- [ ] 除提案文件外零写入
