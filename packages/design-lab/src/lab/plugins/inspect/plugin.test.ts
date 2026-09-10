// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { transformWithOxc } from "vite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiDocs } from "../../plugin-api";
import type { LabObjects, LabPluginContext } from "../../plugin-api";
import type { Camera, Point } from "../../core/types";
import { resetSourceMaps } from "../../sourcemap/cache";
import { createInspect, Inspector, plugin } from "./plugin";
import { LAB_PACKAGE_DIR, locateElement, normalizeSpec } from "./source-location";
import { ProbeCard } from "./probe-fixture";

/**
 * The repo root, found by walking up until this package is under it — cwd
 * differs between `vitest --root packages/design-lab` and `npm test` inside the
 * package. Throws rather than silently resolving to nothing.
 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, LAB_PACKAGE_DIR, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repo root not found above ${process.cwd()}`);
}

const REPO_ROOT = findRepoRoot();
const FIXTURE = `${LAB_PACKAGE_DIR}/src/lab/plugins/inspect/probe-fixture.tsx`;

let host: HTMLElement;
let scroll: HTMLElement;
let shield: HTMLElement;
let camera: Camera;
let origin: Point;
let live: Inspector | null = null;
let reactRoot: Root | null = null;

function stubObjects(): LabObjects {
  return {
    register() {},
    unregister() {},
    layout: () => undefined,
    setLayout() {},
    beginMove() {},
    beginResize() {},
    select() {},
    selectedId: () => null,
  };
}

function ctxFor(): LabPluginContext {
  return {
    host,
    getCamera: () => camera,
    getOrigin: () => origin,
    getViewport: () => ({ width: 1440, height: 900 }),
    getAppearance: () => "light",
    getZoom: () => camera.z,
    viewportCenterPage: () => ({ x: 720, y: 450 }),
    screenAt: () => null,
    objects: stubObjects(),
  };
}

/** The slice of lab DOM this plugin actually reads: a screen with a shield. */
function buildLab(): void {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  // The real lab stamps the mode on this element, and the plugin reads it: a
  // plain click only selects where the shield already owns the press.
  root.setAttribute("data-mode", "explore");
  const layer = document.createElement("div");
  layer.setAttribute("data-lab-layer", "");
  const group = document.createElement("div");
  group.setAttribute("data-screen-id", "playground");
  scroll = document.createElement("div");
  scroll.setAttribute("data-screen-scroll", "playground");
  // The shield is a SIBLING of the scroller and paints over it. That is why a
  // press on screen content reports the shield as its target.
  shield = document.createElement("div");
  group.append(scroll, shield);
  layer.appendChild(group);
  host = document.createElement("div");
  host.dataset.plugin = "inspect";
  root.append(layer, host);
  document.body.appendChild(root);
}

async function mountProbe(): Promise<{ button: HTMLElement; card: HTMLElement }> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement("div");
  scroll.appendChild(mount);
  reactRoot = createRoot(mount);
  const r = reactRoot;
  await act(async () => {
    r.render(createElement(ProbeCard));
  });
  return {
    button: scroll.querySelector(".probe-button") as HTMLElement,
    card: scroll.querySelector(".probe-card") as HTMLElement,
  };
}

function press(
  target: Element,
  init: Partial<MouseEventInit> & { clientX?: number; clientY?: number } = {},
): void {
  const Ctor =
    (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor("pointerdown", { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

function pointer(
  kind: "pointerup" | "pointermove",
  target: Element,
  init: Partial<MouseEventInit> & { clientX?: number; clientY?: number } = {},
): void {
  const Ctor =
    (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  target.dispatchEvent(
    new Ctor(kind, { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

function stubRect(el: Element, r: { left: number; top: number; width: number; height: number }) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }),
  });
}

function boxEl(): HTMLElement {
  return host.querySelector(".li-box") as HTMLElement;
}

function hoverEl(): HTMLElement {
  return host.querySelector(".li-hover") as HTMLElement;
}

function barEl(): HTMLElement {
  return host.querySelector(".li-bar") as HTMLElement;
}

function verb(id: string): HTMLButtonElement {
  return host.querySelector(`.li-verb[data-verb="${id}"]`) as HTMLButtonElement;
}

/** The names of the verbs on offer right now, in order. Hidden ones are out. */
function offered(): string[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>(".li-verb"))
    .filter((b) => !b.hidden)
    .map((b) => b.textContent ?? "");
}

/**
 * A `window.lab` with only the pieces the toolbar reaches for.
 *
 * The toolbar never imports the other plugins -- `text` imports SKIP_HOSTS
 * from the file under test, so an import back would close a cycle -- and this
 * is the door it uses instead. Stubbing the door is stubbing the whole
 * relationship.
 */
function stubBridge(over: {
  canEdit?: boolean;
  focusedId?: string | null;
  onSay?: (text?: string) => void;
  onBegin?: (el: Element) => void;
  onLock?: (id: string) => void;
} = {}): void {
  const apis: Record<string, unknown> = {
    text: {
      canEdit: () => over.canEdit ?? true,
      begin: (el: Element) => {
        over.onBegin?.(el);
        return true;
      },
    },
    properties: {
      say: (t?: string) => {
        over.onSay?.(t);
        return true;
      },
    },
  };
  (window as unknown as { lab: unknown }).lab = {
    plugin: (id: string) => apis[id],
    plugins: () => Object.keys(apis),
    describe: () => [],
    help: () => ({}),
    tokens: { preview: () => {} },
    canvas: {
      screens: () => ["playground"],
      lockInto: (id: string) => {
        over.onLock?.(id);
        return true;
      },
      exit: () => {},
      state: () => ({ mode: "explore", focusedId: over.focusedId ?? null }),
    },
  };
}

function sheet(): string {
  return document.querySelector("style[data-lab-inspect]")?.textContent ?? "";
}

function setMode(mode: string): void {
  (document.querySelector("[data-mode]") as HTMLElement).setAttribute(
    "data-mode",
    mode,
  );
}

beforeEach(() => {
  camera = { x: 0, y: 0, z: 1 };
  origin = { x: 0, y: 0 };
  buildLab();
});

afterEach(() => {
  live?.destroy();
  live = null;
  if (reactRoot) {
    const r = reactRoot;
    act(() => {
      r.unmount();
    });
    reactRoot = null;
  }
  document.body.innerHTML = "";
});

describe("the source probe", () => {
  it("resolves a really-rendered element to the JSX tag that made it", async () => {
    const { button, card } = await mountProbe();

    const loc = locateElement(button);
    expect(loc.problem).toBeNull();
    expect(loc.file).toBe(FIXTURE);
    expect(loc.line).toBe(9);
    expect(loc.column).toBe(7);
    expect(loc.component).toBe("ProbeCard");

    // Parseable is not the same as true. Open the file it named and check that
    // the tag really starts at that line and column.
    const text = readFileSync(join(REPO_ROOT, loc.file as string), "utf8");
    const at = text.split("\n")[(loc.line as number) - 1].slice((loc.column as number) - 1);
    expect(at.startsWith("<button")).toBe(true);

    // A different tag in the same component resolves to a different line.
    const outer = locateElement(card);
    expect(outer.file).toBe(FIXTURE);
    expect(outer.line).toBe(8);
    const outerAt = text.split("\n")[7].slice((outer.column as number) - 1);
    expect(outerAt.startsWith("<div")).toBe(true);
  });

  it("says which way it failed instead of borrowing an ancestor's location", async () => {
    // Deliberately parented inside a React-rendered node: an implementation
    // that climbed the DOM looking for a fiber would answer with the card's
    // line and be believed. It has no location of its own; that is the answer.
    const { card } = await mountProbe();
    const plain = document.createElement("div");
    card.appendChild(plain);
    const loc = locateElement(plain);
    expect(loc.problem).toBe("no-react-fiber");
    expect(loc.file).toBeNull();
    expect(loc.line).toBeNull();
    expect(loc.column).toBeNull();
  });

  it("normalises both address spaces the lab runs in", () => {
    // The dev server, which this test cannot start: vite's root is the package.
    expect(normalizeSpec("http://localhost:5180/src/screens/playground/screen.tsx?t=1712")).toBe(
      `${LAB_PACKAGE_DIR}/src/screens/playground/screen.tsx`,
    );
    // Node/vitest, where frames are absolute filesystem paths.
    expect(normalizeSpec("D:/repo/packages/design-lab/src/lab/x.ts")).toBe(
      "packages/design-lab/src/lab/x.ts",
    );
    // Vendor frames are never an answer.
    expect(normalizeSpec("http://localhost:5180/node_modules/.vite/deps/react.js")).toBeNull();
    expect(normalizeSpec("/@react-refresh")).toBeNull();
  });
});

describe("selecting", () => {
  it("selects the deepest screen element on a shift-click", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    press(button, { shiftKey: true });
    const sel = live.selection();
    expect(sel?.tag).toBe("button");
    expect(sel?.screenId).toBe("playground");
    expect(sel?.className).toBe("probe-button");
    expect(sel?.text).toBe("Buy now");
    expect(sel?.file).toBe(FIXTURE);
    expect(sel?.line).toBe(9);
    expect(sel?.attached).toBe(true);
    expect(sel?.problem).toBeNull();
  });

  it("leaves a plain click to the canvas", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    press(button);
    expect(live.selection()).toBeNull();
    expect(boxEl().hasAttribute("data-show")).toBe(false);
  });

  it("leaves alt-, ctrl- and meta-clicks alone so dragging and duplicating survive", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    for (const mod of ["altKey", "ctrlKey", "metaKey"] as const) {
      press(button, { [mod]: true });
      expect(live.selection()).toBeNull();
    }
    // Shift plus another modifier is somebody else's gesture too.
    press(button, { shiftKey: true, altKey: true });
    expect(live.selection()).toBeNull();
  });

  it("does not consume the press it ignores, and does consume the one it takes", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    const seen: boolean[] = [];
    document.addEventListener("pointerdown", (e) => seen.push(e.defaultPrevented));
    press(button);
    press(button, { shiftKey: true });
    expect(seen).toEqual([false]);
  });

  it("never selects lab chrome or the scroller itself", async () => {
    await mountProbe();
    live = createInspect(ctxFor());
    const chrome = document.createElement("div");
    chrome.dataset.labChrome = "";
    scroll.appendChild(chrome);
    press(chrome, { shiftKey: true });
    expect(live.selection()).toBeNull();
    press(scroll, { shiftKey: true });
    expect(live.selection()).toBeNull();
  });

  it("selectAt converts page units to a client point for hit testing", async () => {
    const { button } = await mountProbe();
    camera = { x: 10, y: 20, z: 2 };
    origin = { x: 5, y: 7 };
    const asked: number[][] = [];
    live = createInspect(ctxFor(), {
      elementsAt: (x, y) => {
        asked.push([x, y]);
        return [button];
      },
    });
    const sel = live.selectAt(100, 200);
    // (page + camera) * zoom + origin
    expect(asked).toEqual([[225, 447]]);
    expect(sel?.tag).toBe("button");
    expect(live.selection()?.line).toBe(9);
  });

  it("selectAt clears and returns null when nothing qualifies at the point", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [] });
    live.selectElement(button);
    expect(live.selection()).not.toBeNull();
    expect(live.selectAt(1, 1)).toBeNull();
    expect(live.selection()).toBeNull();
  });

  it("finds the element under the shield, which is what a real press reports", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });
    // The shield is the event target, as it is in the running lab.
    press(shield, { shiftKey: true, clientX: 40, clientY: 50 });
    expect(live.selection()?.tag).toBe("button");
    expect(live.selection()?.line).toBe(9);
  });
});

describe("showing", () => {
  it("tracks the element through a camera write without rebuilding the DOM", async () => {
    const { button } = await mountProbe();
    origin = { x: 100, y: 50 };
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor());
    live.selectElement(button);

    const before = boxEl();
    expect(before.style.transform).toBe("translate(200px, 200px)");
    expect(before.style.width).toBe("80px");
    expect(before.hasAttribute("data-show")).toBe(true);
    expect(live.outlineRect()).toEqual({ x: 200, y: 200, width: 80, height: 24 });

    // The camera moves: the layer transform slides the element on screen, so
    // its client rect changes and the outline must follow it.
    camera = { x: -40, y: -10, z: 2 };
    stubRect(button, { left: 620, top: 530, width: 160, height: 48 });
    live.onCameraWrite();

    const after = boxEl();
    expect(after).toBe(before); // same node: imperative, not re-rendered
    expect(after.style.transform).toBe("translate(520px, 480px)");
    expect(after.style.width).toBe("160px");
    expect(live.selection()?.line).toBe(9);
    // Same element on the page, so the page-unit box is unchanged by the camera.
    expect(live.outlineRect()).toEqual({ x: 300, y: 250, width: 80, height: 24 });
  });

  it("labels the selection with its tag and file:line", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    live.selectElement(button);
    const label = host.querySelector(".li-label") as HTMLElement;
    expect(label.textContent).toBe("button.probe-button · probe-fixture.tsx:9");
  });
});

/**
 * The inspector in the browser's address space.
 *
 * Everything above renders under vitest, where the stack has already been
 * mapped home before any of it runs — which is why a resolver that handed back
 * the served module's coordinates passed all of it, and why `design_element_at`
 * was quoting lines nobody could edit.
 */
describe("selecting something the dev server served", () => {
  const FIXTURE_REL = "src/lab/plugins/inspect/probe-fixture.tsx";
  const MODULE_URL = `http://localhost:5180/${FIXTURE_REL}?t=91`;

  let servedModule = "";
  let servedButton = { line: 0, column: 0 };

  beforeAll(async () => {
    const out = await transformWithOxc(
      readFileSync(join(REPO_ROOT, FIXTURE), "utf8"),
      "probe-fixture.tsx",
      { lang: "tsx", jsx: { runtime: "automatic", development: true }, sourcemap: true },
    );
    if (!out.map) throw new Error("the transform produced no source map");
    const base64 = Buffer.from(JSON.stringify(out.map), "utf8").toString("base64");
    servedModule = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
    out.code.split("\n").forEach((text, i) => {
      const at = text.indexOf('_jsxDEV("button"');
      // V8 puts a call's column at the first character of the callee.
      if (at >= 0 && servedButton.line === 0) servedButton = { line: i + 1, column: at + 1 };
    });
    if (servedButton.line === 0) throw new Error("no button call in the module");
  });

  /** A node inside a screen, carrying a stack the way chrome writes one. */
  function servedNode(): HTMLElement {
    const el = document.createElement("button");
    el.className = "probe-button";
    Object.assign(el, {
      __reactFiber$served: {
        _debugStack: {
          stack: [
            "Error: react-stack-top-frame",
            `    at ProbeCard (${MODULE_URL}:${servedButton.line}:${servedButton.column})`,
          ].join("\n"),
        },
        return: null,
      },
    });
    scroll.appendChild(el);
    return el;
  }

  function serveModule() {
    const stub = (input: unknown): Promise<{ ok: boolean; text: () => Promise<string> }> =>
      Promise.resolve(
        String(input) === MODULE_URL
          ? { ok: true, text: () => Promise.resolve(servedModule) }
          : { ok: false, text: () => Promise.resolve("") },
      );
    return vi.spyOn(globalThis, "fetch").mockImplementation(stub as unknown as typeof fetch);
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const labelOf = () => (host.querySelector(".li-label") as HTMLElement).textContent;

  beforeEach(() => {
    resetSourceMaps();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSourceMaps();
  });

  it("reports the line in the file once the module's map has been read", async () => {
    expect(servedButton.line).not.toBe(9);
    serveModule();
    const el = servedNode();
    live = createInspect(ctxFor());
    // What the inspector does for itself on mount: read the maps of the tree.
    await settle();

    const sel = live.selectElement(el);
    expect(sel?.problem).toBeNull();
    expect(sel?.file).toBe(FIXTURE);
    expect(sel?.line).toBe(9);
    expect(sel?.column).toBe(7);
    expect(labelOf()).toBe("button.probe-button · probe-fixture.tsx:9");
  });

  it("says it is waiting, then corrects itself, rather than quoting the module", async () => {
    serveModule();
    const el = servedNode();
    live = createInspect(ctxFor());

    // Selected before the maps came back: the honest answer is that there is
    // no line yet, and the label says so instead of reading `…tsx:null`.
    const first = live.selectElement(el);
    expect(first?.problem).toBe("source-map-pending");
    expect(first?.line).toBeNull();
    expect(first?.file).toBe(FIXTURE);
    expect(labelOf()).toBe("button.probe-button · probe-fixture.tsx (source-map-pending)");

    await settle();
    await settle();

    const then = live.selection();
    expect(then?.problem).toBeNull();
    expect(then?.line).toBe(9);
    expect(then?.column).toBe(7);
    expect(labelOf()).toBe("button.probe-button · probe-fixture.tsx:9");
  });

  it("keeps the numbers to itself when the map cannot be read at all", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const el = servedNode();
    live = createInspect(ctxFor());
    live.selectElement(el);
    await settle();
    await settle();

    const sel = live.selection();
    expect(sel?.problem).toBe("source-map-unavailable");
    expect(sel?.line).toBeNull();
    expect(sel?.column).toBeNull();
    expect(sel?.file).toBe(FIXTURE);
    expect(sel?.tag).toBe("button");
  });
});

describe("when the node disappears", () => {
  it("reports it is gone instead of throwing or describing a stale node", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor());
    live.selectElement(button);
    expect(live.selection()?.attached).toBe(true);

    // What a hot reload does: the node is replaced out from under us.
    button.remove();

    expect(() => live?.selection()).not.toThrow();
    const sel = live.selection();
    expect(sel).not.toBeNull();
    expect(sel?.attached).toBe(false);
    expect(sel?.problem).toBe("node-detached");
    // The snapshot survives, so a report can still say what was lost.
    expect(sel?.tag).toBe("button");
    expect(sel?.file).toBe(FIXTURE);
    expect(live.outlineRect()).toBeNull();

    live.onCameraWrite();
    expect(boxEl().hasAttribute("data-show")).toBe(false);
  });
});

describe("teardown", () => {
  it("leaves no listeners, no nodes and no style behind", async () => {
    const { button } = await mountProbe();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const inspector = createInspect(ctxFor());
    inspector.selectElement(button);
    expect(document.querySelectorAll("style[data-lab-inspect]").length).toBe(1);
    expect(host.querySelectorAll(".li-root").length).toBe(1);

    const added = add.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(added.length).toBeGreaterThan(0);

    inspector.destroy();

    const removed = remove.mock.calls.map((c) => [c[0], c[1], c[2]]);
    for (const [type, fn, opts] of added) {
      expect(
        removed.some((r) => r[0] === type && r[1] === fn && r[2] === opts),
      ).toBe(true);
    }
    expect(document.querySelectorAll("style[data-lab-inspect]").length).toBe(0);
    expect(host.children.length).toBe(0);

    // The real proof the listener is gone: a shift-click no longer selects.
    press(button, { shiftKey: true });
    expect(inspector.selection()).toBeNull();

    add.mockRestore();
    remove.mockRestore();
  });

  it("drops the shared style only when the last inspector goes", async () => {
    await mountProbe();
    const a = createInspect(ctxFor());
    const b = createInspect(ctxFor());
    a.destroy();
    expect(document.querySelectorAll("style[data-lab-inspect]").length).toBe(1);
    b.destroy();
    expect(document.querySelectorAll("style[data-lab-inspect]").length).toBe(0);
  });
});

describe("the published api", () => {
  it("documents only methods that exist", () => {
    const docs = plugin.describe ?? [];
    expect(docs.length).toBeGreaterThan(0);
    const proto = Inspector.prototype as unknown as Record<string, unknown>;
    expect(docs.filter((d) => typeof proto[d.name] !== "function").map((d) => d.name)).toEqual([]);
    for (const d of docs) {
      expect(d.signature).toContain(d.name);
      expect(d.summary.length).toBeGreaterThan(0);
    }
  });

  it("passes the lab's own api-doc gate when mounted", () => {
    const handle = plugin.mount(ctxFor());
    expect(handle).not.toBeNull();
    expect(checkApiDocs(plugin.id, handle?.api, plugin.describe)).toEqual([]);
    handle?.destroy();
  });
});

/**
 * The lab makes an inert screen's content `pointer-events: none`, so the hit
 * test sees shield, scroller, frame, group — and no content at all. Measured in
 * the running lab 2026-09-10, and it is why selecting an element had only ever
 * worked after double-clicking into a screen first, Shift-click included.
 *
 * Both references answer it the same way and neither hit-tests from outside:
 * doop posts the point into the frame and lets its runtime answer, onlook asks
 * the frame view. Ours are same-origin nodes, so asking the screen means walking
 * its subtree by rectangle — and a rectangle knows nothing about pointer-events.
 */
describe("finding an element the hit test cannot see", () => {
  /** Give the fixture real boxes; jsdom hands out zeroes. */
  function boxes(map: Array<[Element, [number, number, number, number]]>): void {
    for (const [el, [x, y, w, h]] of map) {
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h,
        toJSON: () => ({}),
      } as DOMRect);
    }
  }

  it("selects through a shield that swallows the whole stack", async () => {
    const { button, card } = await mountProbe();
    boxes([
      [scroll, [0, 0, 400, 300]],
      [card, [10, 10, 380, 200]],
      [button, [20, 40, 100, 30]],
    ]);
    // The shield ate everything: this is what elementsFromPoint really returns
    // over an inactive screen.
    live = createInspect(ctxFor(), { elementsAt: () => [] });

    // The real path: the press lands on the shield, which qualifies as nothing,
    // so it falls through to the hit test — and that is where geometry answers.
    press(shield, { shiftKey: true, clientX: 70, clientY: 55 });
    const sel = live.selection();
    expect(sel?.tag).toBe("button");
    expect(sel?.className).toBe("probe-button");
  });

  it("takes the deepest box, not the first one that contains the point", async () => {
    const { button, card } = await mountProbe();
    boxes([
      [scroll, [0, 0, 400, 300]],
      [card, [10, 10, 380, 200]],
      [button, [20, 40, 100, 30]],
    ]);
    live = createInspect(ctxFor(), { elementsAt: () => [] });

    // Inside the card but outside the button: the card is the honest answer,
    // which is the other side of the test above.
    press(shield, { shiftKey: true, clientX: 200, clientY: 150 });
    expect(live.selection()?.className).toBe("probe-card");
  });

  it("says nothing when the point is outside every screen", async () => {
    await mountProbe();
    boxes([[scroll, [0, 0, 400, 300]]]);
    live = createInspect(ctxFor(), { elementsAt: () => [] });
    press(shield, { shiftKey: true, clientX: 5000, clientY: 5000 });
    expect(live.selection()).toBeNull();
  });
});

describe("the outline that follows the cursor", () => {
  // Before this the only way to learn that anything on these screens could be
  // pointed at was for someone to say the chord out loud, and days in he asked
  // what the notes were even for. The rule the whole thing rests on is one
  // sentence: SHOW THE OUTLINE EXACTLY WHEN A CLICK WOULD TAKE IT. Every test
  // below is that sentence read back in one mode or another.

  let clock = 0;

  beforeEach(() => {
    clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Each move lands past the throttle, so a test move is always a real move. */
  function moveOver(target: Element, init: Partial<MouseEventInit> = {}): void {
    clock += 100;
    pointer("pointermove", target, { clientX: 340, clientY: 262, ...init });
  }

  it("outlines what is under the cursor and names it", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    expect(hoverEl().hasAttribute("data-show")).toBe(false);
    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(true);
    expect(hoverEl().querySelector(".li-tag")?.textContent).toBe(
      "button.probe-button",
    );
    expect(hoverEl().style.transform).toBe("translate(300px, 250px)");
    expect(hoverEl().style.width).toBe("80px");
  });

  it("never takes the pointer while doing it", () => {
    // The screens under this are live apps. An overlay that is `auto` anywhere
    // would eat a click on the thing it is drawing a box around.
    live = createInspect(ctxFor());
    const hover = /\.li-hover\{([^}]*)\}/.exec(sheet())?.[1] ?? "";
    expect(hover).toContain("pointer-events:none");
    const tag = /\.li-tag\{([^}]*)\}/.exec(sheet())?.[1] ?? "";
    expect(tag).not.toContain("pointer-events:auto");
  });

  it("says nothing inside a locked screen, where the click is the app's", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });
    setMode("focus");

    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(false);
  });

  it("unless you are holding the key that would take it", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });
    setMode("focus");

    moveOver(shield, { shiftKey: true });
    expect(hoverEl().hasAttribute("data-show")).toBe(true);
  });

  it("gets out of the way while a screen is being dragged", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(true);
    (document.querySelector("[data-mode]") as HTMLElement).dataset.dragging =
      "move";
    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(false);
  });

  it("does not draw a second box around the selection", async () => {
    // Two outlines on one element reads as neither of them.
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });
    live.selectElement(button);

    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(false);
    expect(boxEl().hasAttribute("data-show")).toBe(true);
  });

  it("reports the hovered box in page units, like the selection does", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    camera = { x: -100, y: -50, z: 2 };
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    expect(live.hoverRect()).toBeNull();
    moveOver(shield);
    expect(live.hoverRect()).toEqual({ x: 250, y: 175, width: 40, height: 12 });
  });

  it("hands over to the selection instead of stacking two rings on one box", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(true);
    live.selectElement(button);
    expect(hoverEl().hasAttribute("data-show")).toBe(false);
    expect(boxEl().hasAttribute("data-show")).toBe(true);
  });

  it("draws a ring that survives dark content and light content alike", () => {
    // Ink on ink is no outline at all, and the canvas holds both kinds of
    // screen at once. A white hairline with a dark ring outside it needs no
    // accent colour, which the house palette does not have to give.
    live = createInspect(ctxFor());
    for (const cls of ["li-box", "li-hover"] as const) {
      const body = new RegExp(`\.${cls}\{([^}]*)\}`).exec(sheet())?.[1] ?? "";
      expect(body, cls).toMatch(/outline:\s*1px solid rgba\(255,255,255/);
      expect(body, cls).toMatch(/box-shadow:\s*0 0 0 2px rgba\(0,0,0/);
      // A wash that reads on both is a wash you cannot see.
      expect(body, cls).not.toMatch(/background:/);
    }
  });

  it("lets go when the pointer leaves the window", async () => {
    const { button } = await mountProbe();
    stubRect(button, { left: 300, top: 250, width: 80, height: 24 });
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    moveOver(shield);
    expect(hoverEl().hasAttribute("data-show")).toBe(true);
    window.dispatchEvent(new Event("pointerleave"));
    expect(hoverEl().hasAttribute("data-show")).toBe(false);
  });
});

describe("the click the hover promises", () => {
  it("a plain click selects, in explore, where the shield already owns it", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });

    press(shield, { clientX: 340, clientY: 262 });
    pointer("pointerup", shield, { clientX: 340, clientY: 262 });
    expect(live.selection()?.tag).toBe("button");
  });

  it("but not inside a locked screen, where the app is live", async () => {
    // Taking a click here would make the lab a worse place to try the thing
    // you are building. Shift-click is still there and still works.
    const { button } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [shield, button] });
    setMode("focus");

    press(button, { clientX: 340, clientY: 262 });
    pointer("pointerup", button, { clientX: 340, clientY: 262 });
    expect(live.selection()).toBeNull();

    press(button, { clientX: 340, clientY: 262, shiftKey: true });
    expect(live.selection()?.tag).toBe("button");
  });

  it("a press that travels is a drag, and a drag keeps the selection", async () => {
    // Panning the canvas is not a reason to forget what you were looking at.
    const { button, card } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [shield, card] });
    live.selectElement(button);

    press(shield, { clientX: 340, clientY: 262 });
    pointer("pointerup", shield, { clientX: 460, clientY: 300 });
    expect(live.selection()?.className).toContain("probe-button");
  });

  it("and a plain click on empty canvas lets go", async () => {
    const { button } = await mountProbe();
    live = createInspect(ctxFor(), { elementsAt: () => [] });
    live.selectElement(button);
    expect(live.selection()).not.toBeNull();

    press(shield, { clientX: 900, clientY: 700 });
    pointer("pointerup", shield, { clientX: 900, clientY: 700 });
    expect(live.selection()).toBeNull();
  });
});

describe("the toolbar on the selected element", () => {
  // doop's bar reads `h1 | Comment | Ask AI | Code | Edit text`, and the thing
  // worth stealing is not the buttons -- we already had all three of these
  // verbs -- but that they are ON the element. The comment lived behind a
  // field in a panel, the text edit behind a double-click that only fires once
  // you are locked into the screen, the location behind reading it off the
  // panel and retyping it. None of that was findable.

  afterEach(() => {
    (window as unknown as { lab?: unknown }).lab = undefined;
    vi.restoreAllMocks();
  });

  it("names the element and puts the verbs beside the name", async () => {
    const { button } = await mountProbe();
    stubBridge();
    live = createInspect(ctxFor());
    live.selectElement(button);

    expect(barEl().querySelector(".li-label")?.textContent).toContain("button");
    expect(offered()).toEqual(["说", "改文字", "复制位置"]);
  });

  it("claims its own press, or none of it works", () => {
    // The one that cost an afternoon. A plain left press the canvas does not
    // recognise starts a pan: `canvas-input` calls preventDefault and takes a
    // pointer capture on the root, and preventDefault on a pointerdown kills
    // the compatibility mouse events -- so `click` never fires. Measured: the
    // button got `pointerdown` and nothing else, and 改文字 did nothing while
    // looking perfectly alive. `data-lab-chrome` is how the lab is told a
    // press is spoken for; the properties panel and the coords chip already
    // wear it.
    live = createInspect(ctxFor());
    expect(barEl().hasAttribute("data-lab-chrome")).toBe(true);
  });

  it("offers 改文字 only where an edit would actually land", async () => {
    // Two-sided. A button that flies the camera into a screen and then does
    // nothing is worse than no button, and the only thing that can answer
    // this is the plugin that owns the rule.
    const { button } = await mountProbe();

    stubBridge({ canEdit: true });
    live = createInspect(ctxFor());
    live.selectElement(button);
    expect(offered()).toContain("改文字");

    live.destroy();
    stubBridge({ canEdit: false });
    live = createInspect(ctxFor());
    live.selectElement(button);
    expect(offered()).not.toContain("改文字");
  });

  it("does not offer to copy a location it does not have", async () => {
    const { card } = await mountProbe();
    const orphan = document.createElement("div");
    card.appendChild(orphan);
    stubBridge();
    live = createInspect(ctxFor());
    live.selectElement(orphan);

    // Made by hand inside a React tree: there is no source for it, and the
    // panel says so. A copy button here would copy the word "null".
    expect(live.selection()?.file).toBeNull();
    expect(offered()).not.toContain("复制位置");
  });

  it("说 goes through the plugin that owns the comment, not around it", async () => {
    const said: (string | undefined)[] = [];
    const { button } = await mountProbe();
    stubBridge({ onSay: (t) => said.push(t) });
    live = createInspect(ctxFor());
    live.selectElement(button);

    verb("say").click();
    expect(said).toEqual([""]);
  });

  it("改文字 locks into the screen first, because the editor refuses outside it", async () => {
    const order: string[] = [];
    const { button } = await mountProbe();
    stubBridge({
      focusedId: null,
      onLock: (id) => order.push(`lock:${id}`),
      onBegin: () => order.push("begin"),
    });
    live = createInspect(ctxFor());
    live.selectElement(button);

    verb("text").click();
    expect(order).toEqual(["lock:playground"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["lock:playground", "begin"]);
  });

  it("and does not fly anywhere it already is", async () => {
    const order: string[] = [];
    const { button } = await mountProbe();
    stubBridge({
      focusedId: "playground",
      onLock: (id) => order.push(`lock:${id}`),
      onBegin: () => order.push("begin"),
    });
    live = createInspect(ctxFor());
    live.selectElement(button);

    verb("text").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["begin"]);
  });

  it("复制位置 copies file:line:col and says that it did", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          written.push(t);
          return Promise.resolve();
        },
      },
    });
    const { button } = await mountProbe();
    stubBridge();
    live = createInspect(ctxFor());
    const sel = live.selectElement(button);

    verb("code").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([`${sel?.file}:${sel?.line}:${sel?.column}`]);
    expect(verb("code").textContent).toBe("已复制");
  });

  it("and admits it when the clipboard is not allowed", async () => {
    // Measured in this lab's own preview pane: `clipboard-write` came back
    // denied and `writeText` threw on a real click. The fallback is the old
    // textarea and `execCommand`, which asks no permission; when even that
    // says no, the button says no. A button that looks alive and quietly does
    // nothing is one you press again, and again, and never learn why.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const { button } = await mountProbe();
    stubBridge();
    live = createInspect(ctxFor());
    live.selectElement(button);

    verb("code").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(verb("code").textContent).toBe("复制不了");
  });

  it("pressing a verb is not pressing the canvas", async () => {
    // Falling through would hit-test the canvas, find our own chrome, qualify
    // nothing, and clear the selection the button was about to act on.
    const { button } = await mountProbe();
    stubBridge();
    live = createInspect(ctxFor(), { elementsAt: () => [] });
    live.selectElement(button);

    press(verb("say"), { clientX: 10, clientY: 10 });
    pointer("pointerup", verb("say"), { clientX: 10, clientY: 10 });
    expect(live.selection()?.tag).toBe("button");
  });

  it("flips below the box when there is no room above it", async () => {
    const { button } = await mountProbe();
    stubBridge();
    live = createInspect(ctxFor());

    stubRect(button, { left: 300, top: 400, width: 80, height: 24 });
    live.selectElement(button);
    expect(boxEl().hasAttribute("data-flip")).toBe(false);

    stubRect(button, { left: 300, top: 4, width: 80, height: 24 });
    live.onCameraWrite();
    expect(boxEl().hasAttribute("data-flip")).toBe(true);
  });
});
