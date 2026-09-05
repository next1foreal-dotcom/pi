import { Labels } from "../../core/page-labels";
import type { LabPlugin } from "../../plugin-api";

/** Handwritten labels as ordinary canvas content. Implementation in core/page-labels. */
export const plugin: LabPlugin = {
  id: "labels",
  order: 30,
  hostSelector: "[data-labels-host]",
  describe: [
    { name: "spawn", signature: "spawn(init?: Partial<LabelItem>): LabelItem", summary: "New handwritten label with a drawn arrow. x/y are PAGE units and default to a small cascade near the page origin, NOT the viewport. Focuses it for typing. `dir` aims the arrow, `scale` sizes text and arrow together. A label is canvas content: it grows and shrinks with the canvas like a frame, and the lab owns its position, selection, arrow-key nudge and undo." },
    { name: "removeLabel", signature: "removeLabel(id: number): void", summary: "Remove one label." },
    { name: "clearLabels", signature: "clearLabels(): void", summary: "Remove every label." },
    { name: "getLabels", signature: "getLabels(): readonly LabelItem[]", summary: "Every label with its text, position, scale and arrow direction." },
    { name: "setScale", signature: "setScale(id: number, scale: number): void", summary: "Scale text and arrow together, in PAGE units — this is the label's size on the canvas, not on the screen. Clamped to the drag handle's range." },
    { name: "setDirection", signature: 'setDirection(id: number, dir: "dr" | "dl" | "ur" | "ul"): void', summary: "Which quadrant the arrow points into — down-right, down-left, up-right, up-left. The label recomposes around it." },
    { name: "isHidden", signature: "isHidden(): boolean", summary: "Are they all hidden right now? Read this to show tool state somewhere." },
    { name: "setHidden", signature: "setHidden(hidden: boolean): void", summary: "Hide or show all labels at once. Nothing is deleted." },
  ],
  mount(ctx) {
    const labels = new Labels({
      host: ctx.host,
      getZoom: () => ctx.getZoom(),
      objects: ctx.objects,
    });
    return {
      handleKey: (e) => labels.handleKey(e, () => ctx.viewportCenterPage()),
      api: labels,
      destroy: () => labels.destroy(),
    };
  },
};
