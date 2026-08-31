<!-- moved from brilliant-local/knowledge/effects/gradients.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes
keywords: [gradient, linear, angle, stops, fill, paint, opacity]
---

# Effect: Gradients

Gradient syntax overview in `tools/create-nodes`.

## Angle semantics

`angle` drives direction via `(angle − 90)°` trig rotation (`src/canvas/paint.ts:24–32`).
Four cardinal anchors:

| angle | direction |
|---|---|
| 0° | bottom → top |
| 90° | left → right |
| 180° | top → bottom |
| 270° | right → left |

135° = diagonal top-left → bottom-right. Any integer or float is valid.

**NEVER write `angle: 90` expecting a top-to-bottom wash — 90° is horizontal. Use 180°.**

## Two-stop recipe

```json
{ "type": "linear", "angle": 180,
  "stops": [{ "offset": 0, "color": "#6366f1" },
             { "offset": 1, "color": "#8b5cf6" }] }
```
<!-- violet → purple: hue shift ≤30° keeps the transition tasteful -->

Dark-card depth tint — same hue, 10–15% luminance drop:
```json
{ "type": "linear", "angle": 180,
  "stops": [{ "offset": 0, "color": "#2a2d3a" },
             { "offset": 1, "color": "#1e2030" }] }
```

## Three-stop recipe

Cluster the midpoint toward 0.25–0.40 — even spacing looks mechanical.

```json
{ "type": "linear", "angle": 180,
  "stops": [{ "offset": 0,    "color": "#ffffff" },
             { "offset": 0.35, "color": "#e0e7ff" },
             { "offset": 1,    "color": "#6366f1" }] }
```
<!-- hero banner: white → soft-indigo midpoint → saturated base -->

## When not to use

**CTA buttons — solid only. Never gradient.**
**Text fill — solid only.** Gradient on `text` works technically but renders unevenly.
**Thin strokes (< 2 px) — solid only.** Banding appears below 2 px.

## Gradient-level opacity

`opacity` on the Paint object fades the whole gradient independently of node opacity:
```json
{ "type": "linear", "angle": 180, "opacity": 0.55,
  "stops": [{ "offset": 0, "color": "#ffffff" },
             { "offset": 1, "color": "#6366f1" }] }
```

## Not supported

Radial, conic, angular gradients — **not available**. The only valid type is `"linear"`
(`src/ai/schemas.ts:10`). Gradient mesh and color-interpolation-mode do not exist.
