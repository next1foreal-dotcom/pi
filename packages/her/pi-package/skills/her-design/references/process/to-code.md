---
assumes: process/steps
keywords: [to-code, handoff, export, tokens, mapping, project, specification, debt, deviation]
---
<!-- authored 2026-08-31 from intake #9 — Matt Vidal, "Figma to Webflow with Claude", section "The project is the specification, Figma is the reference" — generalized: any draft, any codebase -->

# To code — the project is the specification, the design is the reference

When a design lands in a codebase, authority flips. Until now the draft ruled. From here the target project rules: its tokens, its components, its naming, its conventions are the specification. The draft says *what* to build; the project says *how*.

## Read the project before writing anything

Open the target's real system first — tokens (globals.css, tailwind config), the component library in use, naming in neighboring files. Coding from the draft alone produces a foreign body the owner has to rewrite. A class used twelve places is a system; a class used once is just a page — build toward the twelve.

## The mapping is the work

For every value in the draft, find its home in the project:

| The draft has | Do |
|---|---|
| a value that matches an existing token | use the token, never the literal |
| a value one step off a token | snap to the token — the system wins, the design bends |
| a value with no token anywhere near | stop and file it as **token debt** for the owner — add-a-token vs snap is the owner's call, never a silent invention |
| a component the project already owns | use it; do not rebuild a near-duplicate |

Deviating from the draft is a decision, and decisions belong to the owner — flag every deviation, including the ones that feel like improvements. An unflagged improvement is an invisible decision, and invisible decisions accumulate into an architecture nobody chose.

## The draft and the product are allowed to disagree

The rule above — the project wins, the design bends — governs **the moment code is written**. It does not mean the draft must always match what is shipped.

The codebase is the **current** truth. The draft is a **proposed** truth. The distance between them is the proposal; erasing it on sight is erasing the work. A draft that never disagrees with the product is not a design, it is a screenshot.

So: while designing, disagree freely and on purpose. While landing, every disagreement is either adopted deliberately or filed — never quietly absorbed, and never quietly discarded because the token was easier.

<!-- lunagraph (closed source, docs read 2026-09-06): drift between the design and the codebase is the point, not a bug to be eliminated -->

## Write it so it can be handled

He edits by hand — dragging, deleting, duplicating on the canvas. Author so that survives:

- **Siblings sit in a flex or grid with `gap`.** A gap holds when something between them is dragged away or duplicated; margins on each child do not, and the spacing collapses into something nobody chose.
- **Spacing is never a whitespace text node.** It looks identical and it disappears the first time an element is moved.
- **A repeated thing is one component used N times**, not N copies — otherwise a change he makes once has to be made N times, and he will find the one you missed.

This is not tidiness. Every one of these is the difference between "he nudged it" and "he nudged it and something else broke".

<!-- Claude Design: authoring discipline exists to serve direct manipulation -->

## A write request is not a receipt

The call succeeding proves the request was sent, not that the page is right. Evidence is the published render, verified against the draft (review/rendered-page-verify) — states included: hover, focus-visible, disabled, dark.

## Handoff checklist

- zero literals where a token existed
- token-debt list delivered (or explicitly "none")
- deviations from the draft listed, each with its reason
- rendered output verified, not assumed
