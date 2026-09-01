---
assumes: design/foundations, design/composition
keywords: [arrangement, hierarchy, focal point, visual weight, balance, whitespace, spine, alignment, density, eye path]
---
<!-- authored 2026-09-01 · W3 teaching piece · anchors cite research/positive-samples entries -->

# Arrangement — where things sit and how heavy they read

design/composition decides **what exists**; this file decides **where it sits**. A screen that
passes the entry test can still die here: right elements, no hierarchy. blocks/layout gives the
grid arithmetic; this is the judgment the arithmetic serves.

## One focal point

Every screen has exactly one loudest thing. Two competitors both lose — loudness is relative.
Sample 5 (YORK): one giant serif wordmark, and every other letter on the page is small quiet
mono — the wordmark is loud *because* everything else agreed to whisper.
**Check**: zoom the camera far out until text dissolves. What reads first? If the answer takes
two guesses, there is no focal point. If two things tie, demote one.

## Visual weight is a budget

Weight = size × contrast × saturation × density. The page has a fixed amount; spend it where
attention should go. Heavy things must be few — a bold block, a dark band, a saturated accent
each drain the budget. Sample 3 (vercel): the whole landing spends nearly zero on hue (black,
white, black-at-single-digit-alpha) so a lone product screenshot outweighs everything.
**Check**: zoom out until the screen is a thumbnail; the dark blobs are your weight map. It
should match your intended hierarchy — heaviest blob = most important thing, not a decoration.

## The spine

Commit to one alignment spine — usually the content's left edge — and hang every block off it.
Alignment is invisible when present and homemade when absent. At most **one** deliberate
breaker: a single element leaving the spine reads as emphasis; three read as sloppiness.
**Check**: count distinct left edges among sibling blocks (the ruler measures this). More than
three unexplained edges = the fastest tell of an unconsidered screen.

## Negative space is material

Space is the strongest grouping device and the cheapest — proximity groups before any box,
divider, or background tint does. Related things sit close; unrelated things sit far; the gap
IS the boundary. Reach for a border only when spacing alone has failed twice.
Air is not emptiness waiting for ornament (the blob row in review/anti-generic): if a region
feels empty, it usually wants **more** space around the thing that is there, not a new thing.

## Density contrast

Uniform density is the strongest generated-look tell: every region equally full, every gap
equal, nothing to hold on to. Screens read by contrast between **dense islands and open
water** — compress the working areas (sample 1: rico's 40px data rows, four text sizes, three
grays), and let the one important thing breathe disproportionately. Where everything is
comfortable, nothing is important.

## The eye path

Reading order is designed, not hoped for. Size and position make a gradient: focal point →
supporting fact → action. Western defaults scan F (text-heavy) or Z (sparse) — fight them
only on purpose.
**Check**: say the path out loud in one breath — "logo, then the claim, then the number, then
the button." If the sentence stumbles or loops, the arrangement has no order yet.

## Never

- Two focal points. Demote one — loudness is relative or it is nothing.
- Mirror-symmetric centering as a default. Symmetry is a statement (formality, monument);
  unearned, it reads as the template's choice, not yours. Commit to the spine instead.
- Filling air. Space you paid for is doing work; ornament in it is a refund at a loss.
- Equal density everywhere — comfort spread evenly is hierarchy spent to zero.

## In the lab

All four checks are camera moves, not tools: zoom far out for the focal and weight checks
(the spotlight's zoom cap does not apply to you), count edges with the ruler, and walk the
eye path at reading zoom. Run them at the wireframe gate first — gray boxes already have
weight, spines, and density — and again on the draft, where color and type can silently
re-spend the weight budget the wireframe allocated.
