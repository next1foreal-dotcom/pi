import type { Camera, Point, Rect, ResizeEdge } from "./core/types";

/**
 * The lab is a host; design-time tools are plugins.
 *
 * A plugin is a folder: `src/lab/plugins/<id>/plugin.ts` exporting a `plugin`.
 * Nothing else in the lab needs editing to add one — same shape as adding a
 * screen. The rulers, sticky notes and labels that used to be wired into
 * lab-view by name are now just the first three entries here.
 */

/** One callable on a plugin's published api. */
export interface PluginApiDoc {
  /** Method name on the api object. */
  name: string;
  /** How to call it, e.g. `addGuide(axis: "x" | "y", pos: number): Guide`. */
  signature: string;
  /** What it does, and anything a caller would otherwise learn the hard way. */
  summary: string;
}

export interface LabObjectInit {
  /** Globally unique across screens and plugins. Plugins prefix: "note:3". */
  id: string;
  /** The plugin's element. It must live inside the plugin host, which is inside the lab layer, so the camera transform applies to it. */
  el: HTMLElement;
  /** Page units. */
  rect: Rect;
  /** Resize floor in page units. Defaults to MIN_FRAME_W / MIN_FRAME_H. */
  minWidth?: number;
  minHeight?: number;
  /** true -> the lab appends its own selection ring + 8 resize handles into `el`; they show while the object is selected. */
  resizable?: boolean;
  /**
   * "lab" (default) — the lab writes width and height onto the element, as it
   * does for a frame or a sticky.
   * "content" — the element sizes itself (text, intrinsic content) and the lab
   * writes only the position. The registered rect's width/height are still the
   * numbers snapping and zoom-to-selection use, so a content-sized object must
   * push its measured box back with `setLayout` whenever it changes shape.
   */
  sizing?: "lab" | "content";
  /** Fired after a COMMITTED geometry change (pointerup of a move/resize, nudge commit, undo/redo, setLayout). Persist here. */
  onLayout?(rect: Rect): void;
  onSelect?(selected: boolean): void;
}

export interface LabObjects {
  register(init: LabObjectInit): void;
  unregister(id: string): void;
  layout(id: string): Rect | undefined;
  setLayout(id: string, rect: Rect): void;
  beginMove(e: PointerEvent, id: string, opts?: { onClick?(): void }): void;
  beginResize(e: PointerEvent, id: string, edge: ResizeEdge): void;
  select(id: string | null): void;
  selectedId(): string | null;
}

/** What the lab hands a plugin at mount time. */
export interface LabPluginContext {
  /** The element this plugin owns and mounts into. */
  host: HTMLElement;
  getCamera(): Camera;
  /** The canvas root's top-left in client coordinates. */
  getOrigin(): Point;
  getViewport(): { width: number; height: number };
  getAppearance(): "light" | "dark";
  getZoom(): number;
  /** Page-space point under the centre of the viewport. */
  viewportCenterPage(): Point;
  objects: LabObjects;
}

/** What a mounted plugin gives back. Only `destroy` is required. */
export interface LabPluginHandle {
  /**
   * Explore mode only, asked before any lab shortcut. Return true to consume
   * the key — the lab then stops dispatching and calls preventDefault.
   */
  handleKey?(e: KeyboardEvent): boolean;
  /** Called after every camera write, from the lab's own rAF. Stay imperative. */
  onCameraWrite?(): void;
  /** Extra snap targets for frame drags, in page units. */
  getGuides?(): { axis: "x" | "y"; pos: number }[];
  /**
   * The plugin's own instance API, published to callers outside React — an
   * agent driving the page, an e2e test, the console — as
   * `window.lab.plugin("<id>")`. Omit it and the plugin stays keyboard-only.
   */
  api?: unknown;
  destroy(): void;
}

export interface LabPlugin {
  id: string;
  /**
   * What this plugin's published api can do. Required whenever `mount`
   * publishes one — an api nobody can read is an api nobody uses. Lists the
   * calling surface only, not the lab-owned lifecycle (handleKey, destroy…).
   */
  describe?: PluginApiDoc[];
  /** Key-broker order; lower is asked first. Defaults to 100. */
  order?: number;
  /**
   * An existing chrome element to mount into, e.g. "[data-ruler-host]", when a
   * plugin needs a specific place in the z-order. Omit it and the lab creates a
   * fresh div in its plugin layer — that is the path a new plugin takes.
   */
  hostSelector?: string;
  /** Return null to opt out (e.g. the host is missing). */
  mount(ctx: LabPluginContext): LabPluginHandle | null;
}

type PluginModule = { plugin?: LabPlugin; default?: LabPlugin };

/**
 * Pure: given the raw glob result, produce the ordered plugin list. Exported so
 * the registry's rules (missing export, duplicate id, ordering) are testable
 * without a bundler.
 */
export function buildRegistry(
  modules: Record<string, PluginModule>,
  warn: (message: string) => void = () => {},
): LabPlugin[] {
  const seen = new Set<string>();
  const out: LabPlugin[] = [];
  for (const path of Object.keys(modules).sort()) {
    const def = modules[path]?.plugin ?? modules[path]?.default;
    if (!def || typeof def.mount !== "function") {
      warn(`[lab] ${path} exports no plugin; skipped`);
      continue;
    }
    const parts = path.split("/");
    const id = def.id || parts[parts.length - 2] || path;
    if (seen.has(id)) {
      warn(`[lab] duplicate plugin id "${id}" (${path}); skipped`);
      continue;
    }
    seen.add(id);
    out.push({ ...def, id });
  }
  return out.sort(
    (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id),
  );
}

const modules = import.meta.glob<PluginModule>("./plugins/*/plugin.ts", {
  eager: true,
});

export const LAB_PLUGINS: LabPlugin[] = buildRegistry(modules, (m) =>
  console.warn(m),
);

/** The lab's one global. Present only while a lab is mounted. */
export type LabBridge = {
  /** A mounted plugin's published API, or undefined. */
  plugin(id: string): unknown;
  /** Ids of the plugins that published one. */
  plugins(): string[];
  /** What one plugin's api can do. Empty for an id that published none. */
  describe(id: string): PluginApiDoc[];
  /** Every published api, keyed by plugin id. Start here. */
  help(): Record<string, PluginApiDoc[]>;
};

declare global {
  interface Window {
    lab?: LabBridge;
  }
}

/**
 * Docs that disagree with the api are worse than none. Checks the half that
 * can be checked: every documented name must be a real method. The other
 * direction (an undocumented method) is unreachable at runtime — TypeScript's
 * `private` is erased, so every internal is on the prototype too.
 */
export function checkApiDocs(
  id: string,
  api: unknown,
  docs: PluginApiDoc[] | undefined,
): string[] {
  if (api === undefined) return [];
  if (!docs || docs.length === 0) {
    return [`[lab] plugin "${id}" publishes an api but describes nothing`];
  }
  if (typeof api !== "object" || api === null) return [];
  const bag = api as Record<string, unknown>;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (seen.has(d.name)) {
      out.push(`[lab] plugin "${id}" documents "${d.name}" twice`);
    }
    seen.add(d.name);
    if (typeof bag[d.name] !== "function") {
      out.push(
        `[lab] plugin "${id}" documents "${d.name}", which its api does not have`,
      );
    }
  }
  return out;
}

/**
 * Publish the mounted plugins' APIs on `window.lab`, so a tool can be used
 * without pressing its keys. Returns the teardown, which only clears the
 * bridge if it is still the one it installed (StrictMode remounts overlap).
 */
export function publishPluginApis(
  mounted: { id: string; handle: LabPluginHandle; docs?: PluginApiDoc[] }[],
  warn: (message: string) => void = (m) => console.warn(m),
): () => void {
  const apis = new Map<string, unknown>();
  const docs = new Map<string, PluginApiDoc[]>();
  for (const m of mounted) {
    if (m.handle.api === undefined) continue;
    for (const problem of checkApiDocs(m.id, m.handle.api, m.docs)) warn(problem);
    apis.set(m.id, m.handle.api);
    docs.set(m.id, m.docs ?? []);
  }
  const bridge: LabBridge = {
    plugin: (id) => apis.get(id),
    plugins: () => [...apis.keys()],
    describe: (id) => docs.get(id) ?? [],
    help: () => Object.fromEntries(docs),
  };
  window.lab = bridge;
  return () => {
    if (window.lab === bridge) window.lab = undefined;
  };
}
