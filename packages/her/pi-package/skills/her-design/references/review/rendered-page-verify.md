<!-- moved from brilliant-local/knowledge/review/rendered-page-verify.md · 2026-08-31 · living copy: her owns this file -->
---
assumes: review/no-vision-verify
keywords: [verify, rendered, responsive, overflow, geometry, breakpoint, viewport, false-bug, animation, lazy]
---

# Verifying a rendered page (live screens, responsive checks)

Source: Matt Vidal, *figma-to-webflow-workflow* 04 (worked cases) + this project's browser-pane traps (2026-08-31). Canvas-node checks live in `review/no-vision-verify`; this file is for pages that actually render — lab screens, exports, previews.

## Audit element geometry, not container smoke tests

`scrollWidth === clientWidth` is a smoke test, NOT a responsive audit. Three worked cases passed it while structurally shredded: a grid that stays fully active at 390px divides the *available* width — cards rendered 69–100px wide, a hero at 225×106, an h1 at 214px still right-aligned, and nothing ever crossed the viewport edge.

- **Measure the content blocks**: `getBoundingClientRect` on cards, images, headings, text wrappers — do they occupy the width the design intends? A useful finding is numeric: "video renders at 0.70 aspect; design intends 1.27".
- **Then separately scan for true overflow**:
  ```js
  [...document.querySelectorAll('body *')]
    .filter(n => { const r = n.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; })
  ```
  Empty result is meaningful; a matching scrollWidth alone is not. Exclude subtrees under an intentional `overflow:hidden` (marquees, sliders).
- **Sweep the tablet band too**: 991 / 768 / 600 / 480 / 390 / 360. Two real overflows lived at 768px and were invisible at 390.

## False bugs — check the instrument before reporting

1. **Frozen animations**: scroll-triggered reveals render mid-tween in automated browsers — headings look clipped while the element measures fine. Check computed transform/opacity before reporting; final judgment on animated elements needs a real, visible browser.
2. **Lazy-loaded media** measures 0×0 until scrolled into view — `scrollTo` the section first.
3. **Hidden pane freezes time**: a non-compositing pane stops `requestAnimationFrame` entirely and throttles `setTimeout` to seconds — animations look dead and debounced saves look unwired. Synchronous DOM writes still work; judge the wiring by those, never by animation, and wait 4s+ before reading a debounced store.
4. **Layout in a fake viewport is garbage-in**: pass explicit width/height when resizing (presets can silently no-op) and assert `clientWidth !== 0` — and that it equals the width you asked for — before trusting any rect.
5. **Defaults can't change**: an assertion on a value that is already the browser default (e.g. computed `outline: 2px none`) can never fire. Before trusting a probe, ask: *would it trigger if the thing worked?*

## Fix mechanisms, then re-measure

Keep asking why until the answer is a mechanism: "two cards narrower than siblings" was a shrink-to-fit wrapper chain, not the image; "headings overflow at 900px everywhere" was one `white-space: nowrap` on a shared component — one fix, seven pages. Every fix is re-measured; nothing is assumed to have shipped.
