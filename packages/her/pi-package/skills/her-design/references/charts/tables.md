<!-- moved from brilliant-local/knowledge/charts/tables.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, tools/text
keywords: [table, data grid, rows, columns, header row, zebra stripes, column alignment]
---
# Data Viz: Tables

## Column geometry

Fix a column x-offset array before creating anything. Every cell in a column shares `x` and `w` — never
nudge a single cell.

```
col_x = [24, 200, 320, 420]      // left edge of each column
col_w = [176, 120, 100, 96]      // width of each column
row_y(i) = header_y + header_h + i * row_h
```

`row_h` 36–44px · `header_h` 40px · cell `fontSize` 12–13, header 11 uppercase-ish label weight 600.

**Numeric columns use `align: "right"`.** Text columns use `align: "left"`. A right-aligned number column
makes digits line up by place value; left-aligned numbers are unreadable at a glance.

## Skeleton: header + two rows

```json
{ "nodes": [
  { "type": "rect", "name": "table-bg", "x": 24, "y": 40, "w": 492, "h": 128,
    "fill": {"type":"solid","color":"#ffffff"}, "radius": 8 },
  { "type": "rect", "name": "header-rule", "x": 24, "y": 80, "w": 492, "h": 1,
    "fill": {"type":"solid","color":"#e5e7eb"} },
  { "type": "text", "name": "th-name",  "x": 40,  "y": 56, "w": 160, "text": "Product",  "fontSize": 11, "fontWeight": 600, "fill": {"type":"solid","color":"#6b7280"} },
  { "type": "text", "name": "th-units", "x": 216, "y": 56, "w": 104, "text": "Units",    "fontSize": 11, "fontWeight": 600, "align": "right", "fill": {"type":"solid","color":"#6b7280"} },
  { "type": "text", "name": "td-r1-name",  "x": 40,  "y": 96,  "w": 160, "text": "Studio Lamp", "fontSize": 13, "fill": {"type":"solid","color":"#111827"} },
  { "type": "text", "name": "td-r1-units", "x": 216, "y": 96,  "w": 104, "text": "1,284", "fontSize": 13, "align": "right", "fill": {"type":"solid","color":"#111827"} },
  { "type": "text", "name": "td-r2-name",  "x": 40,  "y": 136, "w": 160, "text": "Desk Riser",  "fontSize": 13, "fill": {"type":"solid","color":"#111827"} },
  { "type": "text", "name": "td-r2-units", "x": 216, "y": 136, "w": 104, "text": "976",   "fontSize": 13, "align": "right", "fill": {"type":"solid","color":"#111827"} }
]}
```

## Separators: rules, not stripes

Prefer 1px `rect` rules between rows over filled zebra bands. Rules cost one node per boundary and stay
legible on every skin; zebra fills fight the canvas background when the document colour changes.

```json
{ "type": "rect", "name": "rule-r1", "x": 24, "y": 120, "w": 492, "h": 1, "fill": {"type":"solid","color":"#f3f4f6"} }
```

**Never draw vertical column rules.** Whitespace already separates columns; verticals turn a table into a grid of boxes.

## Emphasis

One emphasis mechanism per table: either a bold first column, or a coloured status cell, or a highlighted
row — never two at once. For a status pill, create a `rect` with `radius: 10` behind a centred `text`,
sized `w = label_w + 20`.

## Anti-patterns

**Three mistakes, by damage:**

1. **Per-cell `x` drift.** Each row computed independently → columns wobble by 1–3px. Fix: derive every cell from the shared `col_x` array.
2. **Left-aligned numbers.** Place values do not line up and the column reads as noise. Numeric columns are always `align: "right"` with a fixed `w`.
3. **Vertical rules plus zebra plus bold headers.** Three separators competing. Pick one, delete the rest.
