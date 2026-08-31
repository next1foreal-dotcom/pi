<!-- moved from brilliant-local/knowledge/review/refine-order.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: review/rubric
keywords: [refine, refinement order, polish, priority, iterate, review loop, re-export, sequence]
---
# Review: Refinement Order

The rubric hands you a list of failures; this file decides which one you touch first. Without an order,
fixing turns into eight passes over the same nodes.

**One law: descend the ladder, never skip up.** A rung above the one you are polishing will move the
node anyway, and the polish is thrown away with it.

## The ladder

| # | Rung | What it looks like here | Fix with |
|---|---|---|---|
| 1 | Broken structure | nodes overlapping, a child clipped by its frame, a whole section missing | `update_nodes` geometry, or delete the section and rebuild it via `create_html` |
| 2 | Wrong hierarchy | you cannot rank the elements; two focal points; the primary action reads as chrome | `fontSize` / `fontWeight` / `fill` on a handful of text nodes |
| 3 | Grid and spacing | unequal gaps, off-scale values, band edges that do not share an x | recompute the column arithmetic, then one batched `update_nodes` |
| 4 | Type and line length | four sizes doing three jobs; lines too long because you chose the `\n` yourself | `fontSize`, `lineHeight`, and re-cut line breaks |
| 5 | Contrast and consistency | muted text too faint, accent leaking onto chrome, three greys doing one job | narrow the palette; reuse the exact hex you already used |
| 6 | Components and states | the same button drawn three ways; no empty, disabled or selected state shown | normalise the shared rect/label geometry; add the missing state |
| 7 | Ornament | icons, dividers, glows, decorative shapes | add, remove, or align — last thing that may be added |
| 8 | Motion | nothing on this canvas moves | notes only, in the handoff, after everything above is settled |

Rung 8 stays on the ladder even though the canvas is static: it names the last thing you are allowed to
think about. Motion belongs in the implementation handoff, never as a rescue for a composition that
failed rungs 1 to 3.

## Re-export between rungs

After any pass that moved or re-created nodes, run `export_canvas` again before judging anything.
**Never judge rung N+1 against the image from before you fixed rung N** — moving a heading changes every
gap under it, and half your remaining fix list is now about pixels that no longer exist.

Small single-field patches (one colour, one label) can be batched before re-exporting. Anything that
changes geometry cannot.

## How each round runs

1. Export, run `review/rubric`, write the noes down.
2. Take the lowest-numbered rung that has a no on it.
3. Fix every failure on that rung in one batched call — not one node per call.
4. Re-export. Re-run the rubric from the top; earlier rungs can regress.
5. Stop when a full rubric pass produces no noes. Report which rungs you touched.

## Common mistakes

**1. Fixing the easy one first (highest harm).** Colour and radius are cheap and visible, so they get
fixed while the reading order is still wrong. The result looks tidier and is no better.

**2. Rebuilding instead of descending.** A rung-3 spacing problem does not justify deleting the section.
Recompute the coordinates and patch.

**3. One call per node.** Ten `update_nodes` calls are ten undo steps and ten chances to drift. Batch
the rung.

**4. Declaring done from the fix list.** Done is a clean rubric pass against a fresh export, not the
absence of remaining items on your list.
