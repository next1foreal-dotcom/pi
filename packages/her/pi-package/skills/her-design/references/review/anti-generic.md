<!-- moved from brilliant-local/knowledge/review/anti-generic.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: design/foundations, design/colors
keywords: [anti-generic, ai-look, cliche, template, slop, originality, metaphor, blacklist]
---
# Review: Anti-Generic

Shares its source with the owner's aesthetic canon — this file only lands those laws on the canvas, as
patterns you can catch in your own `read_canvas` output before anyone sees the export.

Generic output is not a style problem. It is what comes out when the design was derived from the word
"dashboard" instead of from the product. The fix is upstream: name the product's own material first.

## The blacklist

Each row names how the pattern shows up in the node list, so you can catch it without eyes.

| Pattern | The tell in `read_canvas` | Instead |
|---|---|---|
| Gradient headline over three identical cards | one `linear(...)` text fill, then three rects with identical `w`/`h`/`y` | let card size follow card importance; solid fill on the headline |
| Everything centred | every node's `x + w/2` lands on the same value | commit to one edge and let a single element break it |
| Pill soup | `radius` equal to half of `h` on most rects | one radius family; reserve the full pill for one control type |
| Undirected purple-blue gradient | `linear(... #6366f1 → #a855f7)` with no source anywhere in the brief | a colour taken from the product's own material, per `design/colors` |
| "Get Started" buttons | a label with no object — no noun from this product in the string | name the action: "Import a run", "Open the ledger" |
| Empty chart furniture | axis rects and gridlines present, no series `path` or bars | plot real-shaped data, or delete the chart |
| Fake metrics | round numbers, parts that do not sum, identical deltas | numbers a real account would produce, arithmetic that checks out |
| Blobs and glows as filler | `ellipse` with `blur` and no relationship to any content node | remove; if the area feels empty, it wants space, not ornament |
| Uniform everything | one `fontSize`, one gap, one fill across the whole composition | three tiers, per `design/foundations` |

## Where new form actually comes from

Take the material from the product's own domain, then draw with it:

- A log or deploy tool has environments, timelines, statuses, diffs — build from strips and states.
- A writing tool has pages, margins, revisions, marks — build from paper geometry and editorial rhythm.
- A finance tool has ledgers, columns, reconciliations — build from dense aligned rows and restraint.
- A media tool has frames, waveforms, in/out points — build from timeline rhythm.

Write one sentence naming the direction before the first `create_nodes` call, and use it to throw
choices out. Anything that could sit unchanged on a different product's page is a candidate for cutting.

## The limits of novelty

**NEVER buy distinctiveness with readability.** A layout is not original because it is hard to scan.
Legal ways to be different: composition, the material you drew from, density, what you left out. Illegal:
low contrast, off-grid drift, hidden primary actions, decorative motion.

## Common mistakes

**1. Judging the palette instead of the reasoning (highest harm).** Colour is not the offence — a colour
with no source is. A committed, sourced palette passes even when it is saturated.

**2. Treating the list as the whole test.** Avoiding all nine rows still leaves you with a composition
that could belong to anything. Passing means someone can name the product from the export.

**3. Adding a signature element late.** An ornament dropped on a finished generic layout reads as an
ornament. The direction has to shape the geometry from the first batch.
