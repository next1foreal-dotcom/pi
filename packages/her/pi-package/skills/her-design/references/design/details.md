<!-- moved from brilliant-local/knowledge/design/details.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
assumes: design/foundations, review/rubric
keywords: [details, polish, feel, radius, optical, alignment, shadow, tabular, wrapping, stagger, interruptible]
---

# Details that make an interface feel authored

Distilled from Jakub Krehel, *Details That Make Interfaces Feel Better*
(https://jakub.kr/writing/details-that-make-interfaces-feel-better, read in full 2026-08-02;
the author also publishes it as an open skill, `jakubkrehel/make-interfaces-feel-better`).
Reworded for this canvas; the observations are his.

A design rarely fails on its concept. It fails on a dozen small things that a trained eye reads
as carelessness. Every item below is mechanical — none of them is a matter of opinion, and none
of them depends on whether the ground is paper or gallery-dark.

## On the canvas (vector geometry)

**Concentric radius.** When one rounded box sits inside another, the outer radius equals the
inner radius plus the gap between them: `outer = inner + padding`. A card with 20px corners and
12px inner corners must have exactly 8px of padding. Mismatched radii are the single most common
reason nested boxes look wrong without anyone being able to say why. This is checkable — run
`lintGeometry`. The `lintGeometry` report exposes `concentricRadius` findings with a ±1px tolerance.

**Optical alignment beats geometric alignment.** Centring by numbers is right most of the time
and wrong in the cases people actually notice. A button holding an icon and a label needs
slightly less padding on the icon side, because an icon's visual mass sits inside its bounding
box. A triangular play glyph looks off-centre when its box is centred. Trust the eye over the
arithmetic — and when you have no eye, leave a note asking for one.

**Tabular figures for anything that changes.** Numbers that update — timers, counters, progress,
prices — must use a monospaced-digit face, or every tick shifts the layout sideways. On this
canvas that means a mono family for those text nodes; in an export it is
`font-variant-numeric: tabular-nums`.

**Depth by shadow, not by outline.** A hairline border is a solid colour and only works on the
one ground it was picked for. A soft shadow carries transparency, so it survives a change of
ground, a photograph behind it, or a theme switch. Prefer a shadow that reads as an edge:
three stacked layers in light mode — a 1px spread at ~6% black, a 2px offset blur at ~6%, and a
4px blur at ~4% — collapsing to a single 1px spread at ~8% white on a dark ground.

**A hairline on images.** Photographs and screenshots sit better with a 1px inset outline at
about 10% opacity — black on a light ground, white on a dark one. It gives an image the same
edge every other element has, without drawing a border around it.

## In the exported HTML

**Balance titles, prettify paragraphs.** `text-wrap: balance` distributes a heading evenly across
its lines; `text-wrap: pretty` keeps a paragraph from ending on a single orphaned word. They pair:
balance on the title, pretty on the description.

**Thin the text on Mac.** `-webkit-font-smoothing: antialiased` renders text slightly thinner and
crisper where the default subpixel rendering makes it look heavier than intended. Apply it once at
the layout root, not per component.

**Animations must be interruptible.** People change their minds mid-gesture. A CSS transition
retargets toward the newest state and can be cut off; a keyframe animation runs its fixed timeline
and ignores you until it finishes. Use transitions for anything a person drives, and keyframes only
for a staged sequence that plays once. An animation that refuses to be interrupted reads as broken,
not as polished.

**Stagger what enters; soften what leaves.** Do not animate one big block. Break the entrance into
title, description, and controls and offset them by roughly 100ms; a headline can go further and
enter word by word at roughly 80ms apart. A good entrance combines a small rise, a blur, and
opacity — around `translateY(8px)`, `blur(8px)`, over ~800ms on an ease-out curve. The exit should
not be the entrance reversed: fade and blur it out instead of sliding it back. What is leaving
does not deserve the attention of what is arriving.

**Swap icons with motion.** When an icon changes to report a result — copy becoming a checkmark —
cross-fade it with a small scale and blur rather than swapping the glyph instantly. The motion is
what tells the person the action landed.

## How to use this

Read it before the review pass, not after. On the canvas, the checkable items are concentric
radius, tabular figures, and shadow-over-border; `lintGeometry` reports the first. The rest is
craft you apply while drawing, and — for anything optical — craft you must ask a pair of eyes to
confirm, per `process/visual-review`.
