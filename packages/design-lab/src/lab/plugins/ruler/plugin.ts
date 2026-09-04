import { CanvasRuler } from "../../core/canvas-ruler";
import type { LabPlugin } from "../../plugin-api";

/** Canvas-true rulers and guides. Implementation stays in core/canvas-ruler. */
export const plugin: LabPlugin = {
  id: "ruler",
  order: 10,
  hostSelector: "[data-ruler-host]",
  describe: [
    { name: "enable", signature: "enable(): void", summary: "Show the rulers. Same as Shift+R when they are off." },
    { name: "disable", signature: "disable(): void", summary: "Hide the rulers. Guides are kept." },
    { name: "toggle", signature: "toggle(): void", summary: "Flip whichever way they are." },
    { name: "setHidden", signature: "setHidden(hidden: boolean): void", summary: "Hide the chrome while staying in ruler mode (Ctrl+Shift+R). No-op while the rulers are off." },
    { name: "addGuide", signature: 'addGuide(axis: "x" | "y", pos: number): { id: number; axis: "x" | "y"; pos: number }', summary: "Place a guide at a PAGE coordinate — what dragging out of a ruler does by hand. Allowed while the rulers are off; the guide is waiting when you turn them on. Persists." },
    { name: "removeGuide", signature: "removeGuide(id: number): void", summary: "Remove one guide by the id addGuide returned." },
    { name: "clearGuides", signature: "clearGuides(): void", summary: "Remove every guide." },
    { name: "getGuides", signature: 'getGuides(): { id: number; axis: "x" | "y"; pos: number }[]', summary: "The live guides. Returns [] while the rulers are off — this list also feeds frame snapping, which must not start before the user turns them on." },
  ],
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
