<!-- moved from brilliant-local/knowledge/process/visual-review.md · 2026-08-31 · living copy: her owns this file -->
<!-- some passages assume the loora vector canvas — judgment transfers, tool calls do not; her canvas is the design lab -->
---
keywords: [visual-review, export, annotations, no-vision]
---
# Process: Visual Review Without Vision

If you cannot inspect rendered images, exporting a canvas is not visual verification. Do not claim that you visually checked the result. The owner or a model with image access must review the exported frame.

## Finishing sequence

1. Run `lintGeometry` when it is available.
2. Run `export_canvas` to produce the frame artifact.
3. Call `requestVisualReview` with a focused note and optional frame ids.
4. Stop and wait for an annotation created after the request.

A request is answered only when its review sidecar contains an annotation whose `createdAt` is later than the request timestamp. A manual read toggle is not a review signal.

## Annotation return loop

After a later annotation arrives, call `listAnnotations`, make the requested changes, resolve the annotation with `resolveAnnotation`, and export the design again. Repeat the request when another visual pass is needed.

## 判例接住

收到 Owner 的判断后，当场调用 `captureVerdict` 接住；将原话逐字放入 `note`，不要改写或润色。不要等到会话结束再回忆，回忆会把带疑问的思考句写成结论。