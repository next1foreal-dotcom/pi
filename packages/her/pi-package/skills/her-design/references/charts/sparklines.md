<!-- moved from brilliant-local/knowledge/charts/sparklines.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: tools/create-nodes
keywords: [sparkline, micro chart, inline trend, stat card, KPI tile, mini bars]
---
# Data Viz: Sparklines

A sparkline is a chart stripped of every axis, label, and gridline — pure shape, 60–140px wide, 20–40px tall.
It lives inside a stat tile, never alone.

## Line sparkline

Same mapping as a full line chart, minus the chrome. Reserve 2px of vertical padding so the stroke never
clips at the extremes.

```
x_i = origin_x + i * (spark_w / (n - 1))
y_i = (origin_y + spark_h - 2) - (value_i / max_value) * (spark_h - 4)
```

```json
{ "type": "path", "name": "spark-signups", "x": 24, "y": 96,
  "points": [[24,124],[43,118],[62,121],[81,110],[100,113],[119,102],[138,98]],
  "stroke": {"type":"solid","color":"#6366f1"}, "strokeWidth": 1.5 }
```

**`strokeWidth` stays 1.5–2.** A 3px stroke at 32px tall reads as a ribbon, not a trend.

## Bar sparkline

Uniform `rect` nodes, `gap` 2–3px, no radius below 3px bar width. Use bars when the series is discrete
(daily counts), a line when it is continuous (a running rate).

```json
{ "nodes": [
  { "type": "rect", "name": "sb-1", "x": 24, "y": 112, "w": 6, "h": 12, "fill": {"type":"solid","color":"#c7d2fe"} },
  { "type": "rect", "name": "sb-2", "x": 33, "y": 106, "w": 6, "h": 18, "fill": {"type":"solid","color":"#c7d2fe"} },
  { "type": "rect", "name": "sb-3", "x": 42, "y": 100, "w": 6, "h": 24, "fill": {"type":"solid","color":"#c7d2fe"} },
  { "type": "rect", "name": "sb-4", "x": 51, "y": 92,  "w": 6, "h": 32, "fill": {"type":"solid","color":"#6366f1"} }
]}
```

The last bar carries the full-strength hue; earlier bars sit at a tint. That single contrast is the whole
story — no legend needed.

## Stat tile composition

Three text nodes plus the sparkline, in one `frame`: label (11px, muted) · value (28–32px, weight 600) ·
delta (12px, success or danger hue) · spark at the bottom edge. Create the frame first, then the children
with `parent` set to the frame id.

## Anti-patterns

**Three mistakes, by damage:**

1. **Adding axes, ticks, or gridlines.** That is a small line chart, not a sparkline — the compression is the point. Delete the chrome.
2. **Not padding the vertical range.** With `(value/max) * spark_h`, the maximum point sits exactly on the top edge and a 2px stroke clips in half. Subtract 4 from the range.
3. **Two hues in one sparkline.** Colour here means "this is now"; a second hue means nothing and destroys the first signal.
