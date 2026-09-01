---
name: her-design
description: >
  Her's own design system. Load when designing anything: a screen, a page, a component,
  a moodboard; choosing colors, type, or spacing; judging a render; deciding what gets in
  and what gets cut; or wrapping up a design session. The constitution: "Make every detail
  perfect, and limit the number of details." Read the reference files listed inside per
  task before building. Moved from brilliant-local 2026-08-31; this is the living copy,
  inside the selfmod allowlist — her design judgment, hers to sharpen.
---

# Her Design

**"Make every detail perfect, and limit the number of details."**

Limit first, then perfect. Every element must answer *who does this serve* — no answer,
it goes, before any polishing starts. A detail that survives gets finished completely:
exact spacing, a color with a source, every state. Passing a check never earns a detail
its place — when keeping a correct detail conflicts with cutting it, cutting wins.

Reference files are 40–90 lines each. Read every file matching the task before designing —
over-read, never under-read.

## Task → files (in references/)

| Task | Read |
|---|---|
| Starting any design project / which step am I in | process/steps |
| Turning an idea into a brief | process/brief |
| Researching before designing | process/research |
| Needing a sourced example / building a direction board | research/positive-samples |
| Wireframing toward the structure gate | process/wireframe · design/composition |
| Any new design | design/foundations · design/colors · design/typography · design/composition · review/anti-generic · process/direction-first |
| Deciding scope — what gets in, what gets cut | design/composition (entry test: earned its way in? which five get the permanent place?) |
| Important / multi-direction work | process/direction-first · process/variants |
| Pages, heroes, sections | design/blocks/layout |
| Buttons, CTAs, controls | design/blocks/actions |
| Text-heavy work | design/typography |
| Charts, dashboards, KPI tiles | the matching charts/* file(s) |
| Gradients, shadows, glass, glow | effects/gradients · effects/shadows · effects/svg-filters |
| Dark surfaces | effects/dark-mode |
| Rebuild from a screenshot | recreation/from-image |
| Build from a one-line brief | recreation/from-description |
| Tokens before drawing anything | process/tokens-first |
| The owner sent a reference | process/references |
| Screen flows and prototypes | process/flows |
| Judging a render before calling it done | review/rubric · review/refine-order · design/details |
| Verifying a live screen / responsive sweep | review/rendered-page-verify |
| Landing a design into code — export, handoff | process/to-code |
| Ending a design session | process/filing — file decisions, patterns, tool notes, debt before you stop |

Some files carry passages written for the loora vector canvas (flagged at the top of the
file). The judgment transfers; the tool calls do not — your canvas is the design lab:
`design_lab_open`, drafts as screen files under `packages/design-lab/src/screens/`.

## This skill is yours

`her-design` sits inside your selfmod allowlist. When the filing step surfaces a design
lesson that generalizes, propose a patch to these files through the selfmod pipeline —
failure-anchored and evidence-backed, like any other proposal. A workflow that stops
absorbing what it learns is just a document.
