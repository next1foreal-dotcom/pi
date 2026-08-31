<!-- moved from brilliant-local/knowledge/recreation/from-image.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, tools/read-canvas, design/foundations
keywords: [recreation, image, screenshot, reference, rebuild, trace]
---
# Recreation: From Image

`create_nodes` 调用格式见 `tools/create-nodes`。

## Phase 0 — 读图,写观察

动手前写 2-3 句:配色系、区块数、所有能读出的文字。**不写观察就建 = 按刻板印象建图,不是这张截图**。

## Phase 1 — 定画板

按截图宽高建第一个 frame;底色用 `set_background` 或 frame 的 `fill`。

```json
{ "nodes": [{ "type": "frame", "name": "board",
    "x": 0, "y": 0, "w": 390, "h": 844,
    "fill": { "type": "solid", "color": "#0f0f11" } }] }
```

## Phase 2 — 量尺寸,提色板

从截图测量边距、间距、圆角——每个数字量出来再填,**NEVER 估**。
提取色板后写成注释行,建节点时照抄:

```
// 背景 #0f0f11 · 卡片 #1c1c2e · 主色 #6366f1 · 正文 #e2e2e2 · 次文 #8a8a9a
// 外边距 20 · 卡片圆角 16 · 行间距 8
```

## Phase 3 — 从后往前批量建

**绘制顺序 = 创建顺序**:背景 → 容器 → 内容块 → 文字 → 装饰。

**BAD**: 每个节点单独调一次 `create_nodes`——层序乱,父子 id 匹配不上,调用成本高。
**GOOD**: 单次调用,按绘制顺序排列所有节点:

```json
{ "nodes": [
    { "type": "rect", "name": "card",
      "x": 20, "y": 120, "w": 350, "h": 180, "radius": 16,
      "fill": { "type": "solid", "color": "#1c1c2e" },
      "shadow": { "x": 0, "y": 4, "blur": 20, "color": "rgba(0,0,0,0.35)" },
      "parent": "<board-id>" },
    { "type": "text", "name": "card-label",
      "x": 36, "y": 140, "w": 160,
      "text": "Total Balance", "fontSize": 12, "fontWeight": 500,
      "fill": { "type": "solid", "color": "#8a8a9a" },
      "parent": "<board-id>" }
  ]
}
```

`parent` 通过 `read_canvas` 取回真实 id 后填入,**NEVER 猜 id**。

## Phase 4 — 文字节点与换行

系统不自动折行。超宽内容手动插 `\n`:

```json
{ "type": "text", "text": "第一行\n第二行",
  "lineHeight": 1.4, "w": 300, "fontSize": 14, ... }
```

`lineHeight` 是倍数(1.4 = 1.4 × fontSize);`h` 由引擎自动测量,**不要手动设置**。

## 三个最常犯的错(按伤害排序)

1. **跳过测量直接估数字** — 比例误差叠加扭曲整体。先量后建。
2. **分多次调用 create_nodes** — 父子 id 错位,层序混乱。一次调用塞满。
3. **套用"这类 app 惯用配色"而非截图实际色** — 建出的是刻板印象。只用截图里采出的颜色。
