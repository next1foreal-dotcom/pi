<!-- moved from brilliant-local/knowledge/charts/line-charts.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: tools/create-nodes
keywords: [line chart, area chart, trend, series, path, polyline, data visualization]
---
# Data Viz: Line Charts

## Pixel mapping

One series is one `path` node. Points are absolute world coordinates, computed per index:

```
x_i = origin_x + i * (plot_w / (n - 1))
y_i = baseline_y - (value_i / max_value) * plot_h    // baseline_y = origin_y + plot_h
```

`n - 1` in the denominator, not `n` — the last point must land on the right edge.
**Leave `closed` unset for a line.** `closed: true` joins last point to first and fills the shape.

## Skeleton: single series

`origin_x=48, origin_y=20, plot_w=264, plot_h=160, baseline_y=180`. Values [40,72,58,96,120], max=120, n=5, step=66.

```json
{ "nodes": [
  { "type": "rect", "name": "grid-top", "x": 48, "y": 20,  "w": 264, "h": 1, "fill": {"type":"solid","color":"#f3f4f6"} },
  { "type": "rect", "name": "grid-mid", "x": 48, "y": 100, "w": 264, "h": 1, "fill": {"type":"solid","color":"#f3f4f6"} },
  { "type": "line", "name": "baseline", "x": 48, "y": 180,
    "points": [[48,180],[312,180]], "stroke": {"type":"solid","color":"#e5e7eb"}, "strokeWidth": 1 },
  { "type": "path", "name": "series-revenue", "x": 48, "y": 20,
    "points": [[48,127],[114,84],[180,103],[246,52],[312,20]],
    "stroke": {"type":"solid","color":"#6366f1"}, "strokeWidth": 2 },
  { "type": "ellipse", "name": "dot-last", "x": 307, "y": 15, "w": 10, "h": 10,
    "fill": {"type":"solid","color":"#6366f1"} }
]}
```

Derivation: y for 40 = 180 − (40/120)×160 = 127; 72 → 84; 58 → 103; 96 → 52; 120 → 20.

## Area fill under a line

Duplicate the series points, append the two baseline corners, set `closed: true`, and paint a fading gradient.
Create the area **before** the line so the stroke sits on top.

```json
{ "type": "path", "name": "area-revenue", "x": 48, "y": 20, "closed": true,
  "points": [[48,127],[114,84],[180,103],[246,52],[312,20],[312,180],[48,180]],
  "fill": { "type": "linear", "angle": 180,
            "stops": [{"offset":0,"color":"#6366f1"},{"offset":1,"color":"#ffffff"}] },
  "opacity": 0.18 }
```

## Multiple series

One `path` per series, same x grid, distinct `stroke` hue, identical `strokeWidth`. Label each series at its
last point (`x = last_x + 8`, `align: "left"`) instead of drawing a legend box — it reads faster and costs fewer nodes.

## Anti-patterns

**Three mistakes, by damage:**

1. **Dividing by `n` instead of `n - 1`.** The series stops short of the right edge and every gridline misaligns. Fix the step: `plot_w / (n - 1)`.
2. **`closed: true` on the line itself.** The stroke jumps from the last point back to the first, drawing a phantom diagonal. Only the area path is closed.
3. **Varying `strokeWidth` between series.** Thickness reads as importance. Differentiate by hue, never by weight.
