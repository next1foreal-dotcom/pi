<!-- moved from brilliant-local/knowledge/design/blocks/actions.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: tools/create-nodes, design/foundations, design/colors
keywords: [button, cta, primary action, secondary, icon button, pill, hierarchy]
---
# Blocks: Actions

A button is two nodes: a `rect` background and a `text` label, the label parented to nothing and positioned
by arithmetic. Both are created in one call, background first.

## Sizing arithmetic

```
label_w   = ~0.55 * fontSize * character_count      // rough advance for a UI sans
button_w  = label_w + 2 * padding_x
label_y   = button_y + (button_h - label_h) / 2     // optical centre
```

`padding_x` 16–24 · `button_h` 36 (compact) / 44 (default) / 52 (hero) · label `fontSize` 13–15, `fontWeight` 600.
Give the label `w = button_w` and `align: "center"` so it centres itself — **never eyeball `label_x`.**

## The three tiers

| Tier | Background | Label | Use |
|---|---|---|---|
| Primary | solid accent fill | white / near-white | Exactly one per view |
| Secondary | transparent fill, 1px stroke | ink | The alternative path |
| Tertiary | no fill, no stroke | accent ink | Low-stakes, repeated |

**One primary per view — never two.** Two solid CTAs side by side cancel each other out and the eye picks
neither. If both actions are truly equal, both are secondary.

```json
{ "nodes": [
  { "type": "rect", "name": "btn-primary-bg", "x": 40, "y": 200, "w": 148, "h": 44,
    "radius": 10, "fill": {"type":"solid","color":"#4f46e5"} },
  { "type": "text", "name": "btn-primary-label", "x": 40, "y": 214, "w": 148,
    "text": "Start designing", "fontSize": 14, "fontWeight": 600, "align": "center",
    "fill": {"type":"solid","color":"#ffffff"} },
  { "type": "rect", "name": "btn-secondary-bg", "x": 200, "y": 200, "w": 116, "h": 44,
    "radius": 10, "stroke": {"type":"solid","color":"#d1d5db"}, "strokeWidth": 1 },
  { "type": "text", "name": "btn-secondary-label", "x": 200, "y": 214, "w": 116,
    "text": "Learn more", "fontSize": 14, "fontWeight": 600, "align": "center",
    "fill": {"type":"solid","color":"#374151"} }
]}
```

Note the secondary background has **no `fill` key at all** — that is how you get a transparent button.
Passing `fill: null` in `update_nodes` clears an existing one.

## Radius and shape

Radius scales with height: 8 at `h=36`, 10 at `h=44`, 12 at `h=52`. A pill (`radius = h / 2`) is a
deliberate stylistic choice — commit to it across every button in the design or use it nowhere.

**CTA backgrounds are solid — never gradient.** A gradient-filled primary button is the single most
recognizable machine-generated tell. Gradients belong on hero surfaces, not on controls.

## Icon buttons

Square: `w = h`, radius 8–10, glyph centred by the same optical formula. Minimum 32×32 for a pointer target.
Never place a bare icon with no background on a busy surface — it stops reading as clickable.

## Anti-patterns

**Three mistakes, by damage:**

1. **Two primary CTAs in one view.** Hierarchy collapses. Demote one to secondary.
2. **Hand-positioned labels** (`label_x = button_x + 20`). Every button drifts differently. Use `w = button_w` + `align: "center"`.
3. **Gradient button fills.** Reads as generated. Solid accent, always.
