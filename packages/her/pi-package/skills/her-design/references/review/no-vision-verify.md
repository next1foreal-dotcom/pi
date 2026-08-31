<!-- moved from brilliant-local/knowledge/review/no-vision-verify.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: tools/read-canvas
keywords: [no-vision, verification, blind, svg, structure, honesty, claims, disclosure]
---
# Review: Verifying Without Vision

`export_canvas { "format": "png" }` returns an image. If you cannot see images, that block tells you
nothing, and neither does a successful mutation. This file is what you may still verify, and what you
must then say.

The canon's rule is that nobody calls a design good without looking at the pixels. Nothing here weakens
it: this is how to be useful and honest inside that limit, not a way around it.

## What you can still check

| Instrument | What it proves |
|---|---|
| `read_canvas` | every node's type, name, absolute x/y/w/h, parent, fill, stroke, radius, opacity, and paint order |
| `export_canvas { "format": "svg" }` | **text you can read** — the actual rendered geometry, after clipping and layering |
| `create_html` return value | node count, root id, and the degradation notes for anything the importer dropped |
| `create_nodes` / `update_nodes` returns | ids created, count touched, and any `No such id:` tail |

The SVG export is the strongest instrument you have. It is the render, not the request — so it settles
questions the node list cannot.

## Checks that are decidable without eyes

Run these against `read_canvas` plus the SVG export:

- **Arithmetic.** Are repeated gaps equal? Do row items share `w`/`h`? Does every value sit on the 4 px
  scale of `design/foundations`?
- **Containment.** For each child, is its box inside its frame's box? A child outside a frame is clipped
  and invisible — you can prove that from four numbers.
- **Occlusion.** Two opaque nodes with overlapping boxes: the later one in paint order hides the earlier.
  Compare boxes in list order.
- **Overflow.** Text does not wrap here. Estimate the run length against the node's `w`; a long string in
  a narrow box is running past it.
- **Presence.** Does the SVG contain every text string you created? Missing text means dropped, clipped,
  or never rendered.
- **Palette.** Count distinct fills, radii and shadow values. Six greys and four radii are a finding.
- **Contrast.** Text hex against the hex of the node behind it is a computation, not a judgement.

## What you must not do

- **NEVER invent a pixel finding.** "The spacing feels cramped", "the shadow is too heavy", "the
  composition is unbalanced" are claims about an image you did not see. Do not write them.
- **NEVER call a mutation verified.** `Created 9 node(s)` is a receipt for the call, not for the result.
- **NEVER let a structural pass stand in for the visual one.** They answer different questions.

## Say it out loud

Every report you file under this constraint carries the limit in plain words:

> Verified structurally: node geometry, containment and paint order, read back from `read_canvas` and
> the SVG export. **Nobody has looked at the rendered image** — this session has no image vision, so how
> it looks is still unassessed.

Then name the next step: ask the user to look, or hand the export to a reviewer who can. If image vision
is available to you, this file does not apply — run `review/rubric` on the PNG instead.

## Common mistakes

**1. Softening the disclosure (highest harm).** "Looks good structurally" reads to a user as "looks
good". Use the sentence above, unhedged.

**2. Skipping the SVG export.** The node list is your input echoed back. The SVG is the output. Checking
only the first misses everything clipping and z-order do.

**3. Reporting only the checks that passed.** A no-vision pass with zero findings usually means the
checks were not run — the arithmetic ones almost always turn something up.

## Run the geometry lint

When no image vision is available, call lintGeometry before declaring work complete.
textOverlaps, orphansInsideScreen, and frameOverflow must all be empty; any non-empty
result means the work is incomplete. offGrid is informational and does not decide clean.
看不见 ≠ 可以不查，这三类机器算得出。
