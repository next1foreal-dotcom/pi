import { noteSpawnTopLeft, StickyNotes } from "../../core/page-notes";
import type { LabPlugin } from "../../plugin-api";

/** Sticky notes pinned in page space. Implementation stays in core/page-notes. */
export const plugin: LabPlugin = {
  id: "notes",
  order: 20,
  hostSelector: "[data-notes-host]",
  describe: [
    { name: "spawn", signature: "spawn(init?: Partial<StickyNote>): StickyNote", summary: "New note. x/y are PAGE units and default to a small cascade near the page origin, NOT the viewport — pass them, or it lands where nobody is looking. Focuses the new note for typing. Set `text` for plain text, `html` for formatted (sanitized)." },
    { name: "removeNote", signature: "removeNote(id: number): void", summary: "Remove one note." },
    { name: "clearNotes", signature: "clearNotes(): void", summary: "Remove every note." },
    { name: "getNotes", signature: "getNotes(): readonly StickyNote[]", summary: "Every note with its text, position and styling." },
    { name: "setColor", signature: 'setColor(id: number, color: "yellow" | "orange" | "green" | "blue" | "purple" | "pink" | "white" | "black"): void', summary: "Recolor one note." },
    { name: "setFontSize", signature: 'setFontSize(id: number, size: "small" | "medium" | "large" | "huge"): void', summary: "Resize one note's text." },
    { name: "setFont", signature: 'setFont(id: number, font: "inter" | "mynerve"): void', summary: "Typeface: inter, or mynerve for handwriting." },
    { name: "setCompact", signature: "setCompact(id: number, compact: boolean): void", summary: "Collapse a note to a single strip, or restore it." },
    { name: "isHidden", signature: "isHidden(): boolean", summary: "Are they all hidden right now? Read this to show tool state somewhere." },
    { name: "setHidden", signature: "setHidden(hidden: boolean): void", summary: "Hide or show all notes at once. Nothing is deleted." },
  ],
  mount(ctx) {
    const notes = new StickyNotes({
      host: ctx.host,
      getZoom: () => ctx.getZoom(),
    });
    return {
      handleKey: (e) =>
        notes.handleKey(e, () =>
          noteSpawnTopLeft(ctx.viewportCenterPage(), ctx.getZoom()),
        ),
      api: notes,
      destroy: () => notes.destroy(),
    };
  },
};
