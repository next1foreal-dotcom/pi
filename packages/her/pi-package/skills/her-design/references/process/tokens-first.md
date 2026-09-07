<!-- moved from brilliant-local/knowledge/process/tokens-first.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: design/foundations, design/colors, design/typography, process/direction-first
---

# Tokens first

方向句先写进场 token。每个颜色、字体、间距、圆角都要点名已存在的 token；没有对应 token 时，方向句必须明确写出“本单新增 token+出处”。

## 开工前

- 先读 `get_knowledge({ keys: ["process/tokens-first"] })`，再写方向句。
- 记录本单会用到的 token 名称、类别和 source。
- 组件方向同时写出组件名，以及它复用的 token。

## 地色与主题

- **令牌库必须为每种地各备一套 surface / text 角色**（如 `paper/*` 与 `gallery/*`）。只有一套地的库，会替你把设计定死成单一主题——那是库的缺口，不是设计决定。
- 方向句点名的地色，必须能在库里找到对应的整套角色；找不到就先登记这套角色和出处，再动笔。
- 画布文档自身的 `background` 跟随本设计选定的地，不沿用上一张稿子的底色。

## Token 装得下的,和装不下的

Token 是**机器能读的**:色值、字号、间距、圆角、时长。它们要有名字、有出处、能被程序比对。

而**手感装不进键值对**——动效的节奏、构图的呼吸、这一版要给人的温度、为什么这里留白比那里多。硬塞成 token 的下场是它们变成一串谁也不会去读的数,而真正在指导设计的那句话没被写下来。

所以分开两处写:

| 写哪儿 | 装什么 | 谁读 |
|---|---|---|
| token 库 | 值 + 名字 + 出处 | 程序、门禁、`design_system_load` |
| 方向句与本单笔记(散文) | 手感、节奏、氛围、取舍的理由 | 人,和下一次的你 |

判据一句话:**这条东西改一个数就能改掉,还是要改一段话才说得清?**前者进 token,后者进散文。两边都不写的,等于没决定。

<!-- frameground (basta, MIT, 2a793cb) 把这两样分成 DESIGN.md 与 FEEL.md;判断照搬,文件名不搬 -->

## 落画布前

- 颜色必须有 source；无出处的色值不落画布。
- 不能用临时色值代替缺失 token；需要新值时先登记 token 和出处。
- 沿用已有 token 的 value，不在节点里偷偷改成近似值。

## 完成检查

- 方向句逐项对应 token 名称。
- 新增 token 已写明出处，并已保存到设计库。
- 画布节点使用的颜色都能回指到有 source 的 token。
