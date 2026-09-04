import { Labels } from "../../core/page-labels";
import type { LabPlugin } from "../../plugin-api";

/** Handwritten labels with drawn arrows. Implementation stays in core/page-labels. */
export const plugin: LabPlugin = {
  id: "labels",
  order: 30,
  hostSelector: "[data-labels-host]",
  describe: [
    { name: "spawn", signature: "spawn(init?: Partial<LabelItem>): LabelItem", summary: "New handwritten label with a drawn arrow. x/y are PAGE units and default to a small cascade near the page origin, NOT the viewport. Focuses it for typing. `dir` aims the arrow, `scale` sizes text and arrow together." },
    { name: "removeLabel", signature: "removeLabel(id: number): void", summary: "Remove one label." },
    { name: "clearLabels", signature: "clearLabels(): void", summary: "Remove every label." },
    { name: "getLabels", signature: "getLabels(): readonly LabelItem[]", summary: "Every label with its text, position, scale and arrow direction." },
    { name: "setScale", signature: "setScale(id: number, scale: number): void", summary: "Scale text and arrow together. Clamped to the drag handle's range." },
    { name: "setDirection", signature: 'setDirection(id: number, dir: "dr" | "dl" | "ur" | "ul"): void', summary: "Which quadrant the arrow points into — down-right, down-left, up-right, up-left. The label recomposes around it." },
    { name: "setHidden", signature: "setHidden(hidden: boolean): void", summary: "Hide or show all labels at once. Nothing is deleted." },
  ],
  mount(ctx) {
    const labels = new Labels({
      host: ctx.host,
      getZoom: () => ctx.getZoom(),
    });
    return {
      handleKey: (e) => labels.handleKey(e, () => ctx.viewportCenterPage()),
      api: labels,
      destroy: () => labels.destroy(),
    };
  },
};
