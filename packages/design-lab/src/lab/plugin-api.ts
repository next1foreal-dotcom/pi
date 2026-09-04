import type { Camera, Point } from "./core/types";

/**
 * The lab is a host; design-time tools are plugins.
 *
 * A plugin is a folder: `src/lab/plugins/<id>/plugin.ts` exporting a `plugin`.
 * Nothing else in the lab needs editing to add one — same shape as adding a
 * screen. The rulers, sticky notes and labels that used to be wired into
 * lab-view by name are now just the first three entries here.
 */

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
  destroy(): void;
}

export interface LabPlugin {
  id: string;
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
