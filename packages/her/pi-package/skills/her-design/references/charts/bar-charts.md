<!-- moved from brilliant-local/knowledge/charts/bar-charts.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: tools/create-nodes
keywords: [bar chart, column chart, histogram, data visualization, vertical bars, horizontal bars]
---
# Data Viz: Bar Charts

## Pixel mapping

Each bar is a `rect` node. Two formulas drive all geometry:

```
bar_h = (value / max_value) * chart_height
bar_y = baseline_y - bar_h       // baseline_y = origin_y + chart_height
bar_x = origin_x + index * (bar_w + gap)
```

`bar_w` 32–48px · `gap` 12–20px · top `radius` 2–4. **Never set `bar_y = origin_y` — that pins bars at the top.**

## Skeleton: vertical chart

`origin_x=40, origin_y=20, chart_h=160, baseline_y=180`. Values [60,100,80,120], max=120, `bar_w=40, gap=30`.

```json
{ "nodes": [
  { "type": "line", "name": "baseline", "x": 40, "y": 180,
    "points": [[40,180],[320,180]], "stroke": {"type":"solid","color":"#e5e7eb"}, "strokeWidth": 1 },
  { "type": "rect", "name": "bar-jan", "x": 40,  "y": 100, "w": 40, "h": 80,  "fill": {"type":"solid","color":"#6366f1"}, "radius": 3 },
  { "type": "rect", "name": "bar-feb", "x": 110, "y": 47,  "w": 40, "h": 133, "fill": {"type":"solid","color":"#6366f1"}, "radius": 3 },
  { "type": "rect", "name": "bar-mar", "x": 180, "y": 73,  "w": 40, "h": 107, "fill": {"type":"solid","color":"#6366f1"}, "radius": 3 },
  { "type": "rect", "name": "bar-apr", "x": 250, "y": 20,  "w": 40, "h": 160, "fill": {"type":"solid","color":"#6366f1"}, "radius": 3 },
  { "type": "text", "name": "lbl-jan", "x": 40,  "y": 186, "w": 40, "text": "Jan", "fontSize": 11, "align": "center", "fill": {"type":"solid","color":"#9ca3af"} },
  { "type": "text", "name": "lbl-feb", "x": 110, "y": 186, "w": 40, "text": "Feb", "fontSize": 11, "align": "center", "fill": {"type":"solid","color":"#9ca3af"} },
  { "type": "text", "name": "lbl-mar", "x": 180, "y": 186, "w": 40, "text": "Mar", "fontSize": 11, "align": "center", "fill": {"type":"solid","color":"#9ca3af"} },
  { "type": "text", "name": "lbl-apr", "x": 250, "y": 186, "w": 40, "text": "Apr", "fontSize": 11, "align": "center", "fill": {"type":"solid","color":"#9ca3af"} }
]}
```

Derivation: bar-jan h=(60/120)×160=80, y=180−80=100; bar-feb h=133, y=47; bar-mar h=107, y=73; bar-apr h=160, y=20.

## Y-axis labels and gridlines

Place labels in a left gutter (`x=0, w=32, align="right"`). Each gridline is a `rect` with `h=1` at the same `y`.
`label_y = origin_y + chart_height * (1 − tick_fraction) − (font_h / 2)`

```json
{ "type": "text", "name": "y-max", "x": 0, "y": 13,  "w": 32, "text": "120", "fontSize": 10, "align": "right", "fill": {"type":"solid","color":"#9ca3af"} },
{ "type": "text", "name": "y-mid", "x": 0, "y": 93,  "w": 32, "text": "60",  "fontSize": 10, "align": "right", "fill": {"type":"solid","color":"#9ca3af"} },
{ "type": "rect", "name": "grid-t", "x": 40, "y": 20,  "w": 280, "h": 1, "fill": {"type":"solid","color":"#f3f4f6"} },
{ "type": "rect", "name": "grid-m", "x": 40, "y": 100, "w": 280, "h": 1, "fill": {"type":"solid","color":"#f3f4f6"} }
```

## Anti-patterns

**Three mistakes, by damage:**

1. **`bar_y = origin_y` — WRONG.** Bars grow downward from the top edge; tallest bar fills the whole chart. Fix: `bar_y = baseline_y − bar_h`.
2. **No `/ max_value` normalization.** Every bar renders at full `chart_height`. Always multiply by `value / max_value`.
3. **Label `x = bar_x` without `w` or `align`.** Text left-hangs off each bar. Fix: `w = bar_w, align = "center"`.
