<!-- moved from brilliant-local/knowledge/review/rubric.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: design/foundations
keywords: [review, rubric, critique, judge, screenshot, export-canvas, quality-gate, focal point]
---
# Review: Screenshot Rubric

Shares its source with the owner's aesthetic canon — what follows is only the canvas landing form of
those laws, not a second set of them.

Judge the exported image, never the tool return. `Created 12 node(s)` says the call was accepted. It
says nothing about whether the composition reads.

## How to run it

1. `export_canvas { "format": "png", "scale": 2 }` — the export covers the whole canvas, every artboard.
2. Answer every question below. Each one is decidable; "roughly fine" counts as a no.
3. Collect the noes, then let `review/refine-order` decide which one you touch first.
4. Re-export after each pass. **A rubric run against a stale export is worth nothing.**

## Composition

- Does one element take the eye inside two seconds, without hunting?
- Do section edges sit on a small set of repeated x values, or does every band start somewhere new?
- Is open space near the 60% target of `design/foundations`, or is it padding around a wall of nodes?
- Do dense and quiet bands alternate on purpose, or is the whole export one density?

## Hierarchy

- Can you rank title, primary value, primary action, supporting copy — from the pixels alone?
- Do size, weight and lightness step together between tiers? One lever alone gives a weak split.
- Is any secondary text dimmed so far it stopped being readable at 100%?
- Are two elements fighting for the same rank — same size, same weight, same fill?

## Layout

- Are repeated gaps actually equal? Subtract the x values from `read_canvas`; 24 / 24 / 26 is a fail.
- Do cards in a row share `w` and `h` exactly, or land a few px apart?
- **This canvas has no text wrapping.** Does any label run past the `w` given to its text node?
- Is a child clipped away by its frame? A frame clips silently — the node is in `read_canvas` and
  absent from the PNG. Compare the two.
- Do baselines line up across a row, or was each label centred by eye?

## Colour and depth

- Does body text hold contrast against the surface it actually sits on, not the canvas background?
- Is the accent on the one thing that matters, or spread over chrome, icons and borders?
- One radius family, or 6 / 8 / 12 / 14 mixed at random?
- Do shadows fall the same way with consistent blur? One shadow per node, one light source.

## Content and semantics

- Is the copy something this product would really say, or filler — "Lorem", "Card title", "Item 1"?
- Do the numbers hold together: do parts sum to the total, do the dates run in order?
- Do controls look pressable — a filled rect with padding around a label, not a bare text node?
- Does each chart carry plausible data, or is it an empty axis frame with nothing plotted?

## Narrow read

There are no breakpoints here. A narrow layout is a second composition you build, so build it before
claiming the design survives one:

- Re-run the same markup through `create_html` with `maxWidth: 390`, or lay a second artboard by hand.
- Export both. Does the reading order survive, or does the eye now start on a sidebar?
- Do multi-column rows become one column, or squeeze into columns too narrow to read?
- Did anything land outside its frame and get clipped at the narrow width?

## Common mistakes

**1. Judging from the node list (highest harm).** `read_canvas` shows what you asked for; the PNG shows
what happened. Overlap, occlusion and clipping exist only in the second one.

**2. Grading only the change you just made.** Look at the whole export each round — a fixed heading
above a broken grid is still a fail.

**3. Answering "mostly".** Turn every "mostly" into a measurement: read the numbers out of
`read_canvas` and settle it.
