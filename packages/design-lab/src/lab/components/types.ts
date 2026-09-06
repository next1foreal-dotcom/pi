/**
 * The component index: what the canvas knows about the components its screens
 * render.
 *
 * Types only, and deliberately so. The index is computed on the Node side
 * (`build-index.ts`, which needs the TypeScript compiler) and drawn on the
 * browser side (`plugins/components/plugin.ts`). Both need this vocabulary;
 * neither should drag the other's dependencies across, so nothing here has a
 * runtime import.
 */

export type PropInfo = {
  name: string;
  /**
   * The resolved type, printed by the checker. A prop declared
   * `variant?: "ghost" | "solid" | "outline"` reads back as exactly that,
   * not as `string` — that is the whole point of using the compiler.
   */
  type: string;
  /** Declared with a `?`. Says nothing about whether a default exists. */
  optional: boolean;
  /**
   * Every legal value, when the type is a union of string literals (or a
   * single one). Absent when even one constituent is something else, because a
   * half-known set of values is worse than none: a control built from it would
   * silently forbid legal values.
   */
  literalValues?: string[];
  /** Source text of the destructuring default, e.g. `"solid"` or `() => {}`. */
  defaultValue?: string;
};

export type ComponentInstance = {
  /** The screen this instance is rendered under. */
  screenId: string;
  /** Repo-relative, forward slashes — the inspect plugin's format. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based, and points at the `<`, as React's own stack frames do. */
  column: number;
  /** The tag as written. Differs from `name` when the import was renamed. */
  tag: string;
};

/**
 * How a component got into the index. Nothing is here because it exists; it is
 * here because something a screen renders leads to it.
 *
 * - `screen-root`: it *is* a screen — the default export of `screen.tsx`. It
 *   has no JSX tag anywhere, because the lab renders it, so it has no
 *   instances either.
 * - `screen`: a screen file renders it directly.
 * - `component`: only another component renders it.
 *
 * `path` is the chain that reached it, screen id first, ending with the
 * component that renders it: `["product-list", "Browse", "BrowseRow"]` means
 * the product-list screen renders Browse, which renders BrowseRow, which
 * renders this one. Shortest path wins; the first screen to reach it names it.
 */
export type ComponentReach = {
  kind: "screen-root" | "screen" | "component";
  path: string[];
};

/**
 * `local` is the third case the obvious pair misses: a component can be
 * reachable — really rendered, on a real screen — without being exported at
 * all. `BrowseRow` in this repo is exactly that.
 */
export type ExportKind = "default" | "named" | "local";

export type ComponentEntry = {
  /** The name in source. For `export default function LocationPin`, that. */
  name: string;
  /** Repo-relative path of the declaration. */
  file: string;
  exported: ExportKind;
  /**
   * Every distinct tag text this component is rendered under. Usually just
   * `[name]`; a renamed default import (`import LocationIcon from …`) makes
   * this the name a reader would actually search for.
   */
  aliases: string[];
  props: PropInfo[];
  reach: ComponentReach;
  /** Every screen that reaches it. This is the propagation answer. */
  screens: string[];
  /**
   * One per (JSX tag site × screen that reaches it). A tag inside a `.map()`
   * is one instance here and many elements on the canvas — the index counts
   * places in the source, the outlines count what is on screen.
   */
  instances: ComponentInstance[];
  /** Set when the props could not be read, and why. */
  problem?: string;
};

export type ScreenRef = { id: string; file: string };

export type ComponentIndex = {
  screens: ScreenRef[];
  /** Sorted: screen roots in canvas order first, then the rest by name. */
  components: ComponentEntry[];
  /** Anything the build could not do. Empty is the normal case. */
  problems: string[];
};
