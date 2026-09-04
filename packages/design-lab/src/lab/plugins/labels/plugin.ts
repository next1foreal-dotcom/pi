import { Labels } from "../../core/page-labels";
import type { LabPlugin } from "../../plugin-api";

/** Handwritten labels with drawn arrows. Implementation stays in core/page-labels. */
export const plugin: LabPlugin = {
  id: "labels",
  order: 30,
  hostSelector: "[data-labels-host]",
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
