import { CanvasRuler } from "../../core/canvas-ruler";
import type { LabPlugin } from "../../plugin-api";

/** Canvas-true rulers and guides. Implementation stays in core/canvas-ruler. */
export const plugin: LabPlugin = {
  id: "ruler",
  order: 10,
  hostSelector: "[data-ruler-host]",
  mount(ctx) {
    const ruler = new CanvasRuler({
      host: ctx.host,
      getCamera: () => ctx.getCamera(),
      getOrigin: () => ctx.getOrigin(),
      getViewport: () => ctx.getViewport(),
      getAppearance: () => ctx.getAppearance(),
    });
    return {
      handleKey: (e) => ruler.handleKey(e),
      // The rulers' selection band must track a frame drag mid-gesture, so it
      // repaints on every camera write rather than on a React render.
      onCameraWrite: () => ruler.refresh(),
      getGuides: () => ruler.getGuides(),
      api: ruler,
      destroy: () => ruler.destroy(),
    };
  },
};
