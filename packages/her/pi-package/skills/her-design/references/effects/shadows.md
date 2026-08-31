<!-- moved from brilliant-local/knowledge/effects/shadows.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes
keywords: [shadow, drop-shadow, elevation, blur, glow, dark]
---

# Effect: Shadows

Shadow syntax overview in `tools/create-nodes`. One shadow per node; no inner shadow.

## Elevation table

The engine halves `blur` before passing it to `feDropShadow.stdDeviation`
(`src/canvas/NodeView.tsx:66`). Tune in design units:

| level | x | y | blur | color |
|---|---|---|---|---|
| flush | 0 | 1 | 3 | rgba(0,0,0,0.12) |
| raised card | 0 | 4 | 12 | rgba(0,0,0,0.16) |
| floating panel | 0 | 8 | 24 | rgba(0,0,0,0.22) |
| modal | 0 | 16 | 40 | rgba(0,0,0,0.28) |

`y ≥ blur × 0.25` — a purely radial shadow (y=0) reads as unmoored.

## Soft-shadow formula

`y = blur × 0.33`, `x = 0`. Lock alpha to surface weight: raised=0.15, modal=0.30.

```json
{ "type": "rect", "x": 80, "y": 80, "w": 320, "h": 180,
  "fill": { "type": "solid", "color": "#ffffff" },
  "radius": 12,
  "shadow": { "x": 0, "y": 8, "blur": 24, "color": "rgba(0,0,0,0.18)" },
  "name": "card" }
```

## Dark backgrounds: switch to glow

Black shadows disappear on dark surfaces (`--bg` ≤ #3a3a3a in studio/noir themes).
Replace with a colored glow: set `color` to the node's accent at 0.30–0.50 alpha.

```json
"shadow": { "x": 0, "y": 0, "blur": 20, "color": "rgba(99,102,241,0.42)" }
```
<!-- indigo halo for a dark-mode CTA; x=y=0 radiates evenly -->

**NEVER use `rgba(0,0,0,...)` on `noir` or `studio` theme backgrounds** — the shadow vanishes.

## Combining blur + shadow

`blur` and `shadow` compile into the same SVG `<filter>` (`NodeView.tsx:51–69`). They coexist:
the Gaussian blurs the shape body; the drop-shadow casts from that blurred silhouette.

```json
{ "type": "ellipse", "x": 200, "y": 200, "w": 80, "h": 80,
  "fill": { "type": "solid", "color": "#6366f1" },
  "blur": 6,
  "shadow": { "x": 0, "y": 4, "blur": 14, "color": "rgba(99,102,241,0.5)" },
  "name": "glowing-orb" }
```

## Not supported

**Multiple shadows** — one `shadow` object only; no array.
**Inner shadow** — `feDropShadow` casts outward only; inward shadows are not achievable.
**Per-layer shadow** — shadow applies to the whole node, not to fill and stroke independently.
