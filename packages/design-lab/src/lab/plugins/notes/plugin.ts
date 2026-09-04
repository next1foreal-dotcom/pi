import { NOTE_H, NOTE_W, StickyNotes } from "../../core/page-notes";
import type { LabPlugin } from "../../plugin-api";

/** Sticky notes pinned in page space. Implementation stays in core/page-notes. */
export const plugin: LabPlugin = {
  id: "notes",
  order: 20,
  hostSelector: "[data-notes-host]",
  mount(ctx) {
    const notes = new StickyNotes({
      host: ctx.host,
      getZoom: () => ctx.getZoom(),
    });
    return {
      handleKey: (e) =>
        notes.handleKey(e, () => {
          const c = ctx.viewportCenterPage();
          return { x: c.x - NOTE_W / 2, y: c.y - NOTE_H / 2 };
        }),
      destroy: () => notes.destroy(),
    };
  },
};
