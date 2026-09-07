<!-- moved from brilliant-local/knowledge/process/direction-first.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
keywords: [direction, density, mood, color, rejection, create-nodes, create-html]
---
# Process: Direction First

Write one direction sentence before the first `create_nodes` or `create_html` call. The sentence is a gate, not a mood-board caption: it must name a choice that can reject a tempting option.

## Required sentence

Include all four fields in one sentence:

| Field | What to name |
|---|---|
| ground | the surface the work sits on — paper-light, gallery-dark, or another chosen ground — **and why this subject calls for it** |
| density | sparse, medium, or dense, plus the information reason |
| mood | the felt temperature the composition should hold |
| color stance | neutral grayscale, low-saturation earth, or one sourced committed palette |
| rejection | one concrete structure, material, or color the direction will not accept |

**The ground is never a default.** Dark is not the safe choice and neither is light: a tool stared at for hours leans dark, a reading surface, an archive, or a record of a life leans paper. Naming "dark" without a reason drawn from the subject fails this gate. If the token library only carries one ground, that is a gap in the library — say so and source the other ground before drawing, do not let the library decide the design.

Example:

> Sparse archival density with a quiet editorial mood, a near-black and paper-gray shell with one sage accent sourced from the reference; reject three equal cards, centered-everything, and an ungrounded gradient.

The direction sentence must be written in the session reply before any canvas mutation. If the sentence cannot reject a choice, rewrite it. Do not create nodes or HTML while the gate is missing.

## 已有产品里的第 0 步

在一个**已经有产品**的代码库里设计,默认就是**像素级对齐它**——他不需要开口说「先照着我们的 UI 来」。

取值要从**真实组件的源码**里取,而不是从截图上量、更不是四舍五入到 4/8 的网格。产品的按钮高度是 34 就是 34,把它写成 32「因为整」是在悄悄改设计,而且改的是别人已经 ship 的那个。

要偏离它,那是一个**决定**,按 `process/to-code` 的规矩显影出来,不许静默。

<!-- Claude Design(Anthropic 第一方 design 技能)原话:在一个代码库里,用户永远不该需要说「先照着我们的 UI 来」 -->

## Gate checklist

- [ ] 在已有产品的代码库里：方向句默认对齐它，任何偏离都被点名成一个决定
- [ ] the ground is named with a reason drawn from the subject, not inherited from the last design
- [ ] density is named and visible in the planned spacing or information order
- [ ] mood is translated into material, type, or composition decisions
- [ ] every non-neutral color has a source, or the sentence commits to grayscale
- [ ] one negative is specific enough to catch in a node list or screenshot
- [ ] the sentence appears in the session reply before the first create call

A quick sketch is exempt only when the Owner explicitly says “随手” or “草”. The exemption covers the sketch, not a finished page or a review claim.

## Review handoff

Keep the sentence beside the render and use it during review. If the render violates the negative, cut the violating form before adding decoration. If the product material changes, write a new sentence; do not silently mutate the old direction.