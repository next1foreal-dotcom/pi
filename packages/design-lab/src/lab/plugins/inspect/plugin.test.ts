// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiDocs } from "../../plugin-api";
import type { LabObjects, LabPluginContext } from "../../plugin-api";
import type { Camera, Point } from "../../core/types";
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
