<!-- moved from brilliant-local/knowledge/process/filing.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: process/direction-first
keywords: [filing, session-end, compound, decisions, debt, conventions, learning, handoff]
---

# Filing — every session ends by writing down what it paid for

Source: Matt Vidal, *Figma → Claude → Webflow* (2026). "The first page pays for the discovery. Every page after it inherits the result. A workflow that stops absorbing what it learns is just a document."

## The closing move (never skip)

Before a design session ends, file what it produced — small entries, each one roughly an hour the next session does not lose:

| What | Where |
|---|---|
| Decisions made (including ones the model made silently — surface them) | the project manifest / DECISIONS |
| Reusable patterns discovered | propose into conventions / knowledge (do not keep them in your head or the chat) |
| Tool behavior learned (what failed, what worked around) | notes for the next session |
| Anything broken or deferred | a numbered debt list — named, not vibes |

Session two must start where session one ended — never with "what did we decide last time?"

## Ask why until the answer is a mechanism

A symptom filed is noise; a mechanism filed is leverage. Headings overflowing at ~900px on every page was not seven bugs — it was one `white-space: nowrap` on a shared component. One fix, seven pages. **File the mechanism, not the sighting.**

## Un-chosen decisions are the debt that hides

Give a model a design and it fills every unmade decision — reasonably, consistently, and without announcing that a decision was made. The page looks fine while quietly accumulating rules nobody chose. Individually harmless; collectively an architecture. So: any decision the model had to invent gets written down as a decision, or reversed.
