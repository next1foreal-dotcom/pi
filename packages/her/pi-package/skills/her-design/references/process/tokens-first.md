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

## 落画布前

- 颜色必须有 source；无出处的色值不落画布。
- 不能用临时色值代替缺失 token；需要新值时先登记 token 和出处。
- 沿用已有 token 的 value，不在节点里偷偷改成近似值。

## 完成检查

- 方向句逐项对应 token 名称。
- 新增 token 已写明出处，并已保存到设计库。
- 画布节点使用的颜色都能回指到有 source 的 token。
