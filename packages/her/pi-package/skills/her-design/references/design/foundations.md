<!-- moved from brilliant-local/knowledge/design/foundations.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
# Design: Foundations

Set a system before placing any node: spacing rhythm, color roles, type scale. Improvised numbers compound — one off-grid value makes the whole component drift on every resize.

## Spacing Scale

Build on a 4 px unit grid. Eight canonical stops:

| Name | px | Use |
|------|----|-----|
| 2xs  |  4 | icon insets, hairline gaps |
| xs   |  8 | tight component padding |
| sm   | 12 | compact elements |
| md   | 16 | standard padding, column gutter |
| lg   | 24 | section internal rhythm |
| xl   | 32 | sibling-section gap |
| 2xl  | 48 | hero / stage vertical padding |
| 3xl  | 64 | major canvas breaks |

**NEVER combine off-scale values (7, 13, 22) with on-scale values in the same component — one off-grid number prevents everything else from aligning.**

## Three-Tier Hierarchy

Every frame needs exactly three tiers: primary (largest, highest contrast), secondary (smaller or lower opacity), tertiary (muted, supporting). **Using four equal-prominence labels or only two sizes at the same weight destroys all hierarchy signal.**

```json
{
  "nodes": [
    { "type": "text", "x": 40, "y": 40,  "w": 400,
      "text": "Page Title",          "fontSize": 32, "fontWeight": 700,
      "fill": { "type": "solid", "color": "#111827" } },
    { "type": "text", "x": 40, "y": 96,  "w": 400,
      "text": "Supporting subtitle", "fontSize": 16, "fontWeight": 400,
      "fill": { "type": "solid", "color": "#6b7280" } },
    { "type": "text", "x": 40, "y": 132, "w": 400,
      "text": "Meta · overline",     "fontSize": 12, "fontWeight": 400,
      "fill": { "type": "solid", "color": "#9ca3af" } }
  ]
}
```

Size, weight, and lightness step together across the three tiers — shifting only one lever gives weak separation.

## Focal Point

One dominant element per section — the largest, highest-contrast, or most saturated node. **Two equally "biggest" items mean neither dominates; raise one's contrast by 20% or reduce the other to the next scale stop.** If you cannot name the focal point in two seconds, pick one and differentiate it.

## Whitespace

Target 60% open space in any panel. **Adding elements to fill empty space degrades all of them equally — every addition must justify why it is not empty space.** Remove one element before adding padding.

## Anti-patterns

**Three most common errors, by damage:**
1. **Off-grid values** (x: 23, padding: 11) — nothing re-aligns on resize; the layout looks "almost right" and never is.
2. **Flat emphasis** — all labels at 16 px weight 500 — hierarchy collapses to zero.
3. **Gradient CTAs** — gradient texture competes with the label; use solid fills on interactive controls.
