<!-- moved from brilliant-local/knowledge/design/blocks/layout.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, tools/frames-groups, design/foundations
keywords: [layout, hero, header, footer, section, grid, columns, page skeleton, artboard]
---
# Blocks: Layout

There is no auto-layout. Every position is arithmetic you perform before the `create_nodes` call — so
declare the grid first and derive every node from it.

## Declare the grid, then build

```
artboard_w = 1440              // 1440 desktop · 768 tablet · 390 mobile
margin     = 80                // 24 on mobile
content_w  = artboard_w - 2 * margin
col_w      = (content_w - (cols - 1) * gutter) / cols
col_x(i)   = margin + i * (col_w + gutter)
```

12 columns with `gutter = 24` is the default desktop grid. **Compute `col_x` once and reuse it** — a section
that invents its own left edge is the fastest way to make a page look homemade.

## Vertical rhythm

Section padding comes off the spacing scale (8 / 12 / 16 / 24 / 32 / 48 / 64 / 96), not from arbitrary numbers.
Hero 96–128 top and bottom · standard section 64–80 · tight band 40–48. Adjacent sections **share** one gap —
do not stack a 64 bottom onto a 64 top and call it 128 by accident.

## Page skeleton

Each band is a full-bleed `frame`; its contents are children created with `parent` set to that frame's id.
Frames clip, so a band's decoration cannot bleed into the next one.

```json
{ "nodes": [
  { "type": "frame", "name": "hero", "x": 0, "y": 0, "w": 1440, "h": 620,
    "fill": {"type":"solid","color":"#0e0f13"} },
  { "type": "text", "name": "hero-title", "x": 80, "y": 220, "w": 720,
    "text": "One designer.\nThe power of 30.", "fontSize": 56, "fontWeight": 700,
    "lineHeight": 1.05, "letterSpacing": -1.5, "fill": {"type":"solid","color":"#f5f5f5"} },
  { "type": "text", "name": "hero-sub", "x": 80, "y": 364, "w": 520,
    "text": "A local vector canvas where you and your agent\nwork on the same real geometry.",
    "fontSize": 16, "lineHeight": 1.5, "fill": {"type":"solid","color":"#9ca3af"} },
  { "type": "frame", "name": "features", "x": 0, "y": 620, "w": 1440, "h": 480,
    "fill": {"type":"solid","color":"#ffffff"} }
]}
```

Two calls, not one: create the frames, read back their ids, then create children with `parent`.
Text has no auto-wrap — every line break in the example above is an explicit `\n`.

## Alternate the bands

A page of eight identical white sections reads as a wireframe. Vary the rhythm: alternate background
tone, alternate centred and two-column arrangements, and give exactly one band a high-contrast inversion
(dark band on a light page). **One inverted band per page — a second one spends the contrast budget twice.**

## Anti-patterns

**Three mistakes, by damage:**

1. **Per-section improvised margins.** Left edges land at 80, 76, 88 across the page. Derive every x from `col_x(i)`.
2. **Assuming text wraps.** A 900-character paragraph in a 520px-wide text node renders as one endless line. Insert `\n` yourself.
3. **Uniform section padding everywhere.** Equal spacing means no hierarchy — the hero must breathe more than a feature row.
