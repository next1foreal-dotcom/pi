<!-- moved from brilliant-local/knowledge/design/colors.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: design/foundations
keywords: [color, fill, paint, solid, contrast, palette, dark-mode, accent]
---
# Design: Colors

Paint schema syntax (solid vs linear) in `tools/create-nodes`. These rules govern which form to use and when.

## 60-30-10

60% surface · 30% secondary fills and text · 10% accent. **Putting accent on 30%+ of the surface turns every element into a shout — nothing stands out.**

Baseline palette for a neutral UI:

| Role | Hex | Use |
|------|-----|-----|
| surface | #f9fafb | page and panel backgrounds |
| surface-raised | #ffffff | card, modal, sheet fill |
| text-primary | #111827 | headings, body |
| text-secondary | #6b7280 | subtitles, placeholders |
| text-muted | #9ca3af | captions, disabled labels |
| accent | #6366f1 | CTA, selected states |
| danger | #ef4444 | destructive actions |
| success | #10b981 | confirmation states |

## Solid vs Gradient

**CTA fills are always solid — never gradient.** A gradient draws the eye to its own texture; the button label loses.

```json
{ "fill": { "type": "linear", "angle": 135,
    "stops": [{"offset": 0, "color": "#6366f1"}, {"offset": 1, "color": "#8b5cf6"}] } }
```

The pattern above is **WRONG** on a button. Use this instead:

```json
{ "fill": { "type": "solid", "color": "#6366f1" } }
```

Gradients belong in backgrounds, decorative shapes, and illustration — not interactive controls.

## Contrast Minimums

Normal text (<18 px): 4.5:1 · Large or bold text (≥18 px): 3:1.
`#6b7280` on `#f9fafb` passes 4.5:1. `#9ca3af` on `#f9fafb` fails — use it only for non-essential decoration.

## Dark Mode

**Swap roles — do not invert.** Surface → #111827, surface-raised → #1f2937, text-primary → #f9fafb, text-secondary → #9ca3af. Accent desaturates 10–15%.

```json
{ "type": "rect", "x": 0, "y": 0, "w": 320, "h": 180,
  "fill": { "type": "solid", "color": "#1f2937" }, "radius": 12 }
```

**Avoid #000000 backgrounds and #ffffff text** — full-pole contrast causes eye strain; stay 5–10% off the poles in both directions.

## Data Visualization

Use distinct hues for chart series — never role colors. Six-slot maximum:
`#6366f1` · `#10b981` · `#f59e0b` · `#ef4444` · `#06b6d4` · `#8b5cf6`.

**Never repurpose `#ef4444` as a non-error data series** — it carries "danger" meaning; users read status into color automatically.
