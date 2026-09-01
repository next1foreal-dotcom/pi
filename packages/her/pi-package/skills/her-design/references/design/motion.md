---
assumes: design/foundations, design/details, design/arrangement
keywords: [motion, animation, transition, easing, duration, stagger, scroll, entrance, reduced-motion, interruptible]
---
<!-- authored 2026-09-01 · rescues the portable half of loora's tools/motion.md · promotes the staging rules from design/details -->

# Motion — what earns movement, and at what values

The constitution applies to motion first, because motion is the cheapest thing to add and the most
expensive thing to sit through. **Movement is a detail like any other: it must earn its way in.**

## What earns motion

Motion exists to make a change legible: something entered, left, succeeded, failed, or moved from
here to there. If nothing changed state, nothing should move. Idle loops, ambient drift, decorative
pulses, and scroll-triggered fades on every element are the motion form of slop — they are the tell
that no one asked what the movement was for.

Three questions per animated thing, at the wireframe gate — before anyone tunes a curve:

1. **What state change is this making legible?** No answer, no animation.
2. **Would a person notice its absence?** If not, it is decoration; cut it.
3. **What does it cost the twentieth time?** Every motion is paid on every visit; a delightful
   1.2s intro is a toll booth by the third read.

What you cut buys care: one entrance choreographed properly beats twelve elements fading in.

## Values have sources — never invent a curve

The gap between a considered page and a generic one is not the idea, it is the numbers: the exact
easing, the duration, the stagger step. So the same law as research applies — **measured value >
declared token > custom value with a written reason**. Nothing else may appear.

Where measured values come from: the site's own CSS (`transition-duration`,
`animation-timing-function`, `cubic-bezier(...)`, `--*ease*` custom properties), captured in the
Motion section of an extract, or a project's own motion tokens. A `cubic-bezier` copied exactly is
evidence; "feels about right" is not. When you must invent one, say so in the delivery and say why.

Declare tokens once, in CSS custom properties, and reference them everywhere:

```css
:root { --motion-fast: 160ms; --motion-fast-ease: ease-out; }
.status { transition: opacity var(--motion-fast) var(--motion-fast-ease); }
```

Loose durations scattered through a stylesheet are the same failure as loose hex values.

## Staging

- **Interruptible for anything a person drives.** A CSS transition retargets toward the newest
  state and can be cut off mid-flight; a keyframe animation runs its fixed timeline and ignores
  the person until it finishes. Transitions for driven changes, keyframes only for a staged
  sequence that plays once. Motion that refuses to be interrupted reads as broken.
- **Stagger instead of blocks.** A section that fades in as one rectangle reads as a slide. Break
  the entrance into parts with a small constant step between them so the eye is led along the path
  arrangement already designed.
- **Exits are softer and shorter than entrances.** Arriving deserves attention; leaving does not.
- **One choreographed moment per page, not twelve.** Spend the motion budget the way
  design/arrangement spends the weight budget: concentrated, not spread.

## Scroll

Scroll-driven motion ties progress to position — it is a *state*, not a *timeline*, so it must
survive scrolling backwards, fast, and landing mid-page on reload. Reserve it for things whose
progress is the point. Every element fading up on entry is not scroll design; it is a page that
distrusts its own content.

## Reduced motion is not optional

Wrap every non-essential animation, and never let a reduced-motion page break — the information
must survive the removal of the movement:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important;
    transition-duration: .01ms !important; scroll-behavior: auto !important;
  }
}
```

Script-driven sequences check the same query before they start, and skip or shorten.

## Looking, and the assets you look at

Two tools close the loop this file assumes:

- `design_lab_still <screenId>` photographs your own screen and hands back the path — **read it**.
  A screen you have not looked at is not verified, and no amount of correct reasoning substitutes
  for the frame.
- `design_asset_shot` photographs a locally running app into a real asset. For a product page the
  product is the hero asset: run the real thing and place that frame, rather than leaving a gray
  box where the proof should be. Each shot carries a receipt naming its source — an asset whose
  origin you cannot state does not belong in a design.

## Verifying motion in the lab

Motion is the one thing a still frame cannot show, and the pane lies about it in a specific way:
**a hidden pane freezes `requestAnimationFrame` and throttles timers**, so animations look dead and
debounced work looks unwired when the pane is merely collapsed. Before calling motion broken, prove
the pane is visible; then check state (a class, a data attribute, a computed value) rather than
watching, since what you can assert is the state the motion carries, not the motion itself.

## Never

- An animation whose state change you cannot name.
- A duration or curve with no source, unlabeled.
- Blocking the reader: an intro that must finish before the page can be read.
- Motion that changes meaning — if the page says something different with animations off, the
  information was inside the movement, and that is a structure bug, not a motion one.
