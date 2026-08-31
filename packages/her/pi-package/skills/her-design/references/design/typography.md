<!-- moved from brilliant-local/knowledge/design/typography.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: design/foundations
keywords: [text, font, fontSize, fontWeight, lineHeight, letterSpacing, typography, type-scale, align]
---
# Design: Typography

Text node properties (fontSize, fontFamily, fontWeight, lineHeight, letterSpacing, align) in `tools/create-nodes`. These rules govern when to use which values.

## Type Scale

Body = 16 px. Jump between stops is 1.25×–1.5×. **NEVER use 18 or 22 px — they sit between stops and break the rhythm of any design they appear in.**

| Name | px | Use |
|------|----|-----|
| micro    | 11 | badges, tiny labels |
| caption  | 13 | overlines, metadata |
| body-sm  | 14 | dense UI, secondary body |
| body     | 16 | standard body |
| subtitle | 20 | subheadings |
| heading-sm | 24 | section headings |
| heading  | 32 | page headings |
| hero     | 48 | hero titles |
| display  | 64 | splash, watermark |

## Three-Lever Hierarchy

Move **size + weight + color** together. Shifting only one lever produces weak contrast; all three together give maximum signal per tier.

```json
{ "nodes": [
    { "type": "text", "x": 0, "y": 0,  "w": 360,
      "text": "Section Heading", "fontSize": 24, "fontWeight": 700,
      "fill": { "type": "solid", "color": "#111827" } },
    { "type": "text", "x": 0, "y": 52, "w": 360,
      "text": "Supporting body text here.", "fontSize": 16, "fontWeight": 400,
      "fill": { "type": "solid", "color": "#6b7280" } }
] }
```

## Spacing Properties

Body: `lineHeight: 1.6`. Headings 24 px+: `lineHeight: 1.2`. Display 48 px+: `lineHeight: 1.05`.
Tighten large headings: `letterSpacing: -0.5`. Open uppercase or small-caps labels: `letterSpacing: 1.2`.
**NEVER apply negative `letterSpacing` below 18 px — it degrades readability and causes characters to collide.**

## One Loudest Line

Every screen has exactly one text element at ≥2× body size. It is the focal point. **Two "biggest" text elements cancel each other — shrink one to the next stop down.**

```json
{ "type": "text", "x": 60, "y": 80, "w": 560,
  "text": "Learn faster.", "fontSize": 48, "fontWeight": 800,
  "align": "center",
  "fill": { "type": "solid", "color": "#111827" } }
```

## Font Family

Pair at most two families: one geometric sans for body, one serif for editorial headings only.
**Three or more font families in one design always reads as an accident, not a decision.**

fontFamily accepts any CSS font-family string. Always supply a fallback: `"Inter, system-ui, sans-serif"`.
