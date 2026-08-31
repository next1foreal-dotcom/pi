<!-- moved from brilliant-local/knowledge/recreation/from-description.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, tools/read-canvas, design/foundations, design/colors
keywords: [recreation, description, prompt, from-text, layout, hierarchy, composition]
---
# Recreation: From Description

`create_nodes` 调用格式见 `tools/create-nodes`。

## Step 1 — 明确产物类型与画板尺寸

需求只有一句话时先确认两件事:产物是什么端、用在什么场景。确认后锁定画板,不再改动。

| 产物 | 画板尺寸 |
|---|---|
| 手机界面 | 390 × 844 |
| 平板 UI | 768 × 1024 |
| 桌面仪表盘 | 1440 × 900 |
| 社交封面图 | 1200 × 630 |

## Step 2 — 定信息层级

把所有内容按重要度分三级,建节点前写下来:

```
// 一级:主标题、核心数字、主 CTA — 最大字号,最高对比度
// 二级:副标题、说明文字、次要操作 — 中等字号,中等对比度
// 三级:标签、元数据、分隔线 — 最小字号,最低对比度
```

相邻层级字号差 ≥ 4pt;三级不争注意力。

## Step 3 — 选克制配色

描述类任务没有参考图,自研配色时遵守:60% 中性底色 · 30% 次要色 · 10% 强调色。强调色只落在主 CTA 和关键数字上。

**BAD**: 三种强调色并列——每块区域都在抢视线,重心散乱。
**GOOD**: 一种强调色,其余全用中性系:

```
// 底色 #0f0f11 · 面板 #1a1a2e · 强调 #6366f1
// 正文 #e2e2e2 · 次文 #8a8a9a · 分隔 #2a2a3a
```

## Step 4 — 两步批量建节点

层序:背景 → 容器 → 内容块 → 文字 → 图标装饰。**需要两次调用**:先建 frame 取回真实 id,再批量建所有子节点。

调用一 — 建 frame:

```json
{ "nodes": [
    { "type": "frame", "name": "screen",
      "x": 0, "y": 0, "w": 390, "h": 844,
      "fill": { "type": "solid", "color": "#0f0f11" } }
]}
```

返回:`"Created 1 node(s): <actual-screen-id>"`。捕获这个 id。

调用二 — 批量建所有子节点(用真实 id 填入 parent):

```json
{ "nodes": [
    { "type": "rect", "name": "hero-card",
      "x": 20, "y": 60, "w": 350, "h": 200, "radius": 20,
      "fill": { "type": "linear", "angle": 135,
        "stops": [{"offset": 0, "color": "#6366f1"}, {"offset": 1, "color": "#8b5cf6"}] },
      "parent": "<actual-screen-id>" },
    { "type": "text", "name": "hero-title",
      "x": 36, "y": 116, "w": 318,
      "text": "Analytics", "fontSize": 32, "fontWeight": 700,
      "fill": { "type": "solid", "color": "#ffffff" },
      "parent": "<actual-screen-id>" }
]}
```

**NEVER 猜 id** — 用调用一的返回值直接填入,不要编造。

## Step 5 — 文字节点与换行

文字无自动折行。多行内容用 `\n` 分段;`lineHeight` 控行距(倍数);`align` 控水平对齐。

```json
{ "type": "text",
  "text": "欢迎回来\n今日概览", "lineHeight": 1.5,
  "align": "center", "fontSize": 18, "fontWeight": 600,
  "w": 350, ... }
```

`h` 由引擎自动测量,**不要手动设置**。换行只认 `\n`,不自动折行。
