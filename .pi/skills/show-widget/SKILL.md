---
name: show-widget
description: 讨论方案/概念/对比时,递一张可视化草图给 Fei 看(不只是文字)。用 her_show_widget 工具把自包含的内联 HTML/SVG 渲染进他 preview 面板的 widget 视图。触发:"画一下"、"给我看看"、"示意图"、"草图"、"可视化"、"图示",或任何你在解释结构/流程/布局/数据时,一张图比一段话更清楚的时刻。
---

# show-widget — 对话内画草图

## 什么时候画(草图先行)

在你要向 Fei 解释一件有形状的事时,先想一句:这个用一张图会不会比一段话更快让他"看见"?会,就画。典型场景:

- 讲**方案/架构**:模块怎么摆、数据往哪流、谁调谁 → 一张框图。
- 讲**布局/界面**:页面长什么样、控件在哪 → 一张线框草图。
- 讲**对比**:A 方案 vs B 方案、改前 vs 改后 → 并排两栏。
- 讲**数据/趋势**:占比、时间线、分布 → 一张小图表。
- 讲**流程/状态**:步骤顺序、状态机 → 流程图。

不确定该不该画时,画。草图便宜,一句"我画个示意"胜过三段描述。但别硬画:纯粹一两句能说清的事、或他明说只要结论时,不要为了画而画。

## 怎么画

调 `her_show_widget`,参数:
- `html`:一段**完全自包含**的 HTML 或 SVG(见下铁律)。传 `null` 清空 widget 视图。
- `title`(可选):给这张草图起个短标题,显示在卡片顶栏。
- `focus`(可选,默认 false):**省着用**。默认 false = 面板只在 widget 标签上亮一个未读角标,不打断 Fei 手头的活;只有"这张图他必须现在放大看"时才传 true 抢占面板。

### 铁律(违反会被静默掐掉或渲染不出)

1. **自包含,零外部资源**:只能用内联 `<style>` 和内联 `<script>`。**禁止**外链 CSS、外链 JS、外链字体、远程图片、fetch/XHR/WebSocket——沙箱的 CSP 是 `default-src 'none'`,一切网络请求都会被拦死。图片要嵌就用 `data:` URI。
2. **中性黑白灰基调**:配色走中性黑白灰,和 Samantha 产品基调一致;别上蓝紫橙黄等高饱和色(数据本身需要区分时用低饱和灰阶或一处克制的强调色)。
3. **暗底可读**:草图会在可能是深色的面板里显示。别假设白底黑字——显式设背景与文字色,或用能在深浅底上都读得清的中性色。
4. **≤ 256KB**:整段 html 上限 256KB(按字节算,中文更占字节)。草图要轻,超了会被服务端拒绝(报 too-large)。
5. **不写 `<!doctype>`/`<html>`/`<head>`/`<body>` 外壳**:直接给内容片段即可(内联 `<style>`/`<script>`/`<svg>` 都行),外壳由渲染层套上。

### 这是草图,不是交付物

widget 是给 Fei **当场看一眼**的一次性草图,不是产品成品,也不落库(面板重启即失)。所以:别过度打磨、别写几百行、别追求像素级完美。传达清楚结构/意思就够了,快过慢好。真要做正式可交付的页面/组件,那是 Studio 构建流程的事,不是这里。

## 画图配方(照抄这套,草图就不糙)

草图 ≠ 简陋。用下面这套统一的"底料 + 配方",三分钟画出有设计感的图。

### 底料(每张图开头贴这段 style,再往下写内容)

```html
<style>
  .wrap{font-family:system-ui;background:#161616;color:#e6e6e6;padding:20px;border-radius:10px}
  .t{font-size:15px;font-weight:600;margin:0 0 4px}
  .sub{font-size:12px;color:#9a9a9a;margin:0 0 14px}
  .grid{display:grid;gap:10px}
  .card{background:#1f1f1f;border:1px solid #2e2e2e;border-radius:8px;padding:12px 14px}
  .card .h{font-size:13px;font-weight:600;margin:0 0 4px}
  .card .d{font-size:12px;color:#9a9a9a;margin:0;line-height:1.5}
  .tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#242e28;color:#8fc7a2;margin-top:8px}
  .tag.dim{background:#262626;color:#9a9a9a}
  .kpi{font-size:22px;font-weight:600;margin:2px 0 0}
  .hl{color:#8fc7a2}
</style>
```

配色纪律:整图就两个层次的灰(#161616 底/#1f1f1f 卡)+ 一处低饱和强调色(默认灰绿 #8fc7a2,表示"已启用/正常/重点");禁蓝紫橙黄高饱和。

### 配方一 · 卡片墙(讲"有哪些东西/各自状态"——能力清单、模块盘点、选项对比)

```html
<div class="wrap"><p class="t">标题</p><p class="sub">一句话说明</p>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
  <div class="card"><p class="h">条目名</p><p class="d">一句话描述</p><span class="tag">状态</span></div>
  <div class="card"><p class="h">条目名</p><p class="d">一句话描述</p><span class="tag dim">状态</span></div>
</div></div>
```

### 配方二 · 流程/管道(讲"先后与因果"——数据流、调用链、状态机)

用 SVG,统一语汇:圆角矩形节点(fill:none, stroke:#666, rx:6)+ 直线箭头 + 终点节点描边用强调色;文字 12px #ddd 居中。节点 ≤6 个,多了拆两行或砍。

### 配方三 · 左右对比(讲"A vs B / 改前改后")

`.grid` 两列,每列一张 `.card`,卡头用 `.h` 写方案名,正文 3-4 行 `.d`,差异点用 `<span class="hl">` 点亮。**必须有结构性差异再用对比,同骨架换词不算对比。**

### 通用纪律

- 每张图必有 `.t` 标题 + `.sub` 一句话——Fei 扫一眼就知道这图在说什么。
- 层次靠**字号(15/13/12)+ 灰度(#e6e6e6/#9a9a9a)**拉开,不靠加粗一堆、不靠彩色。
- 留白比内容重要:卡片间距 10px 起,wrap 内边距 20px,别把字挤满。
- 信息量:一张图讲一件事;超过 8 个元素先想"能不能砍",而不是"能不能塞"。

画完在对话里用一句话点出你想让他看的重点("左边是输入、中间校验、右边进入,你看这个顺序对吗?"),别让他对着图自己猜你要表达什么。
