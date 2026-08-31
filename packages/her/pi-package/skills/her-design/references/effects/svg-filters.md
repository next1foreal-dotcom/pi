<!-- moved from brilliant-local/knowledge/effects/svg-filters.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, effects/shadows
keywords: [filter, blur, gaussian, glass, glow, noise, feGaussianBlur, feDropShadow]
---

# Effect: SVG Filters (Honest Guide)

Two filter primitives exist: **Gaussian blur** and **drop shadow**. No filter chains.

## What is real

The engine writes exactly one `<filter>` per node when `blur` or `shadow` (or both) are set
(`src/canvas/NodeView.tsx:51–88`):

- `<feGaussianBlur stdDeviation={blur}>` — whole-node blur; `stdDeviation` = the `blur` value as-is.
- `<feDropShadow dx={x} dy={y} stdDeviation={blur/2} floodColor={color}>` — `blur` is halved here.

**NEVER assume feBlend, feColorMatrix, feTurbulence, feFlood, feComposite, feDisplacementMap,
feImage, or feConvolveMatrix are available.** They are not wired up.

## Blur usage

`blur` applies Gaussian softness to the entire node (fill + stroke as one unit). Use for:
- Soft aura behind a shape
- Blurred backing layer in a multi-node glass assembly

```json
{ "type": "rect", "x": 60, "y": 60, "w": 360, "h": 240,
  "fill": { "type": "solid", "color": "rgba(255,255,255,0.14)" },
  "stroke": { "type": "solid", "color": "rgba(255,255,255,0.30)" },
  "strokeWidth": 1, "radius": 16,
  "blur": 0,
  "name": "glass-panel-top" }
```
<!-- the blur goes on a duplicate of the content layer beneath, not on this node -->

## Approximating glass (frosted)

**Backdrop-filter is not supported.** We cannot blur what is behind a node.
Build the illusion with two nodes:
1. Duplicate the content layer; set `opacity: 0.25`, `blur: 14` — the "smeared backing".
2. Place the glass rect on top: semi-transparent fill, white stroke, no blur of its own.

Call `read_canvas` to get the backing node ID before duplicating via `update_nodes`.

## Approximating glow

Set `shadow` with `x: 0, y: 0` and a colored `color`. See `effects/shadows` for full recipes.

```json
"shadow": { "x": 0, "y": 0, "blur": 28, "color": "rgba(99,102,241,0.55)" }
```

Widen the halo by increasing `blur`. Works best on dark canvases.

## Not supported — definitive list

| Effect | Status |
|---|---|
| backdrop-filter / background-blur | **not supported** |
| mix-blend-mode | **not supported** — no `blendMode` on `SceneNode` (`types.ts`) |
| multiple shadows | **not supported** |
| inner shadow | **not supported** |
| noise / grain / feTurbulence | **not supported** |
| SVG filter chain (feBlend, feColorMatrix, etc.) | **not supported** |
| masks on non-frame nodes | **not supported** |
| feFlood color overlay | **not supported** |

Do not attempt grain with packed small rects — it will not render as texture. Log it as visual debt.
