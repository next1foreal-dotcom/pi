<!-- moved from brilliant-local/knowledge/effects/dark-mode.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/create-nodes, effects/shadows, effects/gradients
keywords: [dark-mode, theme, noir, studio, paper, background, contrast, glow]
---

# Effect: Dark Mode

The app ships three themes (`src/ui/theme.ts`): **studio** (graphite dark, default),
**noir** (warm-black + lime), **paper** (light editorial blue). Canvas `background` is
set independently via `set_background`; read the live value before composing.

**NEVER design in a vacuum.** Call `read_canvas` first; inspect `doc.background`.

## Reconfigure, don't invert

Dark → light is not a color inversion. Three mandatory adjustments:

- **Fills**: on dark grounds, raise luminance 10–20% and drop saturation 10–15%.
- **Shadows**: replace black shadows with accent-colored glow on dark grounds. See `effects/shadows`.
- **Strokes**: swap hard borders for `rgba(255,255,255,0.12–0.20)` separators on dark grounds.

**WRONG → RIGHT:** copy-pasting the same `rgba(0,0,0,0.15)` shadow from a light design onto a
dark canvas → invisible. Recalibrate for each ground.

## Studio ground (`#393d3c`)

Mid-dark graphite. Black shadows still read; keep alpha modest. Achromatic accent `#dfe2e1`.

```json
{ "type": "rect", "x": 0, "y": 0, "w": 400, "h": 220,
  "fill": { "type": "linear", "angle": 180,
    "stops": [{ "offset": 0, "color": "#4a4f5e" },
               { "offset": 1, "color": "#373b3a" }] },
  "shadow": { "x": 0, "y": 6, "blur": 20, "color": "rgba(0,0,0,0.32)" },
  "radius": 10, "name": "studio-card" }
```

## Noir ground (`#1b1b18`)

Near-black. Black shadows are invisible — switch to glow. Lime accent `#aeb731` is the only
system color that reliably pops on this ground without washing out.

```json
{ "type": "rect", "x": 0, "y": 0, "w": 400, "h": 220,
  "fill": { "type": "solid", "color": "#22231f" },
  "stroke": { "type": "solid", "color": "rgba(174,183,49,0.18)" },
  "strokeWidth": 1,
  "shadow": { "x": 0, "y": 0, "blur": 24, "color": "rgba(174,183,49,0.20)" },
  "radius": 10, "name": "noir-card" }
```

## Paper ground (`#f5f5f5`)

Light. Shadows work with `rgba(15,18,20,N)`. Use editorial blue `#3567c6` for accents.
Drop luminance to 40–60% for interactive fills to maintain contrast against the ground.

```json
{ "type": "rect", "x": 0, "y": 0, "w": 400, "h": 220,
  "fill": { "type": "solid", "color": "#ffffff" },
  "shadow": { "x": 0, "y": 4, "blur": 16, "color": "rgba(15,18,20,0.12)" },
  "radius": 10, "name": "paper-card" }
```

## Gradient contrast by ground

- **Dark ground**: compress stop range — ≤15% luminance delta between stops.
- **Light ground**: widen stop range — 30–40% delta for visible depth.
- **NEVER reuse the same gradient spec on both dark and light grounds without recalibrating.**
