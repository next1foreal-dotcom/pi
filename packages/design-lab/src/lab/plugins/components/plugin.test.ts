// @vitest-environment jsdom

/**
 * The join, end to end: the index is built from `probe-fixture.tsx` by the
 * TypeScript compiler, and the very same file is then rendered by React. If
 * the compiler's coordinates and React's `_debugStack` coordinates ever drift
 * apart, every test in "showing" below goes red — which is the point, because
 * that drift is silent everywhere else.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { transformWithOxc } from "vite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiDocs } from "../../plugin-api";
import type { LabObjects, LabPluginContext } from "../../plugin-api";
import type { Camera, Point } from "../../core/types";
import { buildComponentIndex, LAB_PACKAGE_DIR } from "../../components/build-index.ts";
import type { ComponentIndex } from "../../components/types";
import { resetSourceMaps } from "../../sourcemap/cache";
import { ComponentsView, createComponents, INDEX_URL, plugin } from "./plugin";
import ProbePanel from "./probe-fixture";

function findPackageRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "src/lab/components/build-index.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`design-lab root not found above ${process.cwd()}`);
}

const PACKAGE_ROOT = findPackageRoot();
const FIXTURE_FILE = join(
  PACKAGE_ROOT,
  "src/lab/plugins/components/probe-fixture.tsx",
);

/**
 * The index for the fixture, built the same way the dev server builds the real
 * one — the fixture's default export stands in for a screen's. Nothing here is
 * hand-written, so a hand-written-but-wrong location cannot pass.
 */
const FIXTURE_INDEX: ComponentIndex = buildComponentIndex({
  packageRoot: PACKAGE_ROOT,
  screenFiles: [FIXTURE_FILE],
});

const loadFixture = () => Promise.resolve(FIXTURE_INDEX);

let host: HTMLElement;
let scroll: HTMLElement;
let shield: HTMLElement;
let camera: Camera;
let origin: Point;
let live: ComponentsView | null = null;
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

/** The slice of lab DOM this plugin reads: a screen with a shield over it. */
function buildLab(): void {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  const layer = document.createElement("div");
  layer.setAttribute("data-lab-layer", "");
  const group = document.createElement("div");
  group.setAttribute("data-screen-id", "probe");
  scroll = document.createElement("div");
  scroll.setAttribute("data-screen-scroll", "probe");
  shield = document.createElement("div");
  group.append(scroll, shield);
  layer.appendChild(group);
  host = document.createElement("div");
  host.dataset.plugin = "components";
  root.append(layer, host);
  document.body.appendChild(root);
}

async function mountProbe(): Promise<{
  rows: HTMLElement[];
  labels: HTMLElement[];
  panel: HTMLElement;
}> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement("div");
  scroll.appendChild(mount);
  reactRoot = createRoot(mount);
  const r = reactRoot;
  await act(async () => {
    r.render(createElement(ProbePanel));
  });
  return {
    rows: [...scroll.querySelectorAll(".cx-row")] as HTMLElement[],
    labels: [...scroll.querySelectorAll(".cx-label")] as HTMLElement[],
    panel: scroll.querySelector(".cx-panel") as HTMLElement,
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

function stubRect(
  el: Element,
  r: { left: number; top: number; width: number; height: number },
) {
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

/** All pending microtasks: the pointer handler dispatches an async chain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function boxes(): HTMLElement[] {
  return [...host.querySelectorAll(".lc-box")] as HTMLElement[];
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

describe("the fixture index", () => {
  it("was built from source, and its locations point at real tags", () => {
    const row = FIXTURE_INDEX.components.find((c) => c.name === "Row");
    expect(row?.instances).toHaveLength(2);
    const text = readFileSync(FIXTURE_FILE, "utf8").split("\n");
    for (const at of row?.instances ?? []) {
      expect(text[at.line - 1].slice(at.column - 1).startsWith("<Row")).toBe(true);
    }
    // And it read the literal union off a real component while it was there.
    expect(row?.props.find((p) => p.name === "tone")?.literalValues).toEqual([
      "quiet",
      "loud",
    ]);
    expect(row?.props.find((p) => p.name === "tone")?.defaultValue).toBe('"quiet"');
  });
});

describe("reading the index", () => {
  it("lists what the screens reach, with the screens each one touches", async () => {
    live = createComponents(ctxFor(), loadFixture);
    const rows = await live.list();
    expect(rows.map((r) => r.name)).toEqual(["ProbePanel", "Row", "Chip", "Tree"]);
    const row = rows.find((r) => r.name === "Row");
    expect(row?.screens).toEqual(["components"]);
    expect(row?.instances).toBe(2);
    expect(row?.reach.kind).toBe("screen");
  });

  it("hands back a component's instances by name or by its renamed tag", async () => {
    live = createComponents(ctxFor(), loadFixture);
    expect(await live.instancesOf("Row")).toHaveLength(2);
    expect(await live.instancesOf("row")).toHaveLength(2);
    expect(await live.instancesOf("Nonesuch")).toEqual([]);
  });

  it("mounts and answers empty when there is no dev server behind it", async () => {
    // The lab has to come up without one, so this exercises the REAL loader
    // with the fetch failing, not an injected stub that fails differently.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("dev-server-only"));
    live = createComponents(ctxFor());
    expect(await live.list()).toEqual([]);
    expect(await live.show("Row")).toBeNull();
    expect(boxes()).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith(INDEX_URL);
    spy.mockRestore();
  });
});

describe("showing every instance at once", () => {
  it("outlines each live element of the component, and only those", async () => {
    const { rows, panel } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);

    const result = await live.show("Row");
    expect(result?.component.name).toBe("Row");
    // Two places in the source, two elements on the canvas.
    expect(result?.component.instances).toHaveLength(2);
    expect(result?.outlined).toBe(2);
    expect(boxes()).toHaveLength(2);
    expect(live.shown()).toBe("Row");

    // The outlines sit on the rows, not on the panel that contains them and
    // not on the labels inside them.
    stubRect(rows[0], { left: 10, top: 20, width: 100, height: 30 });
    stubRect(rows[1], { left: 10, top: 60, width: 100, height: 30 });
    stubRect(panel, { left: 0, top: 0, width: 200, height: 200 });
    live.onCameraWrite();
    expect(live.outlineRects()).toEqual([
      { x: 10, y: 20, width: 100, height: 30 },
      { x: 10, y: 60, width: 100, height: 30 },
    ]);
  });

  it("keeps the outlines on the same elements through a camera write", async () => {
    const { rows } = await mountProbe();
    origin = { x: 100, y: 50 };
    stubRect(rows[0], { left: 300, top: 250, width: 80, height: 24 });
    stubRect(rows[1], { left: 300, top: 290, width: 80, height: 24 });
    live = createComponents(ctxFor(), loadFixture);
    await live.show("Row");

    const before = boxes();
    expect(before[0].style.transform).toBe("translate(200px, 200px)");
    expect(before[1].style.transform).toBe("translate(200px, 240px)");
    expect(before[0].hasAttribute("data-show")).toBe(true);

    // The camera moves: the layer transform slides the elements on screen, so
    // their client rects change and the outlines must follow.
    camera = { x: -40, y: -10, z: 2 };
    stubRect(rows[0], { left: 620, top: 530, width: 160, height: 48 });
    stubRect(rows[1], { left: 620, top: 610, width: 160, height: 48 });
    live.onCameraWrite();

    const after = boxes();
    expect(after[0]).toBe(before[0]); // same nodes: imperative, not re-rendered
    expect(after[0].style.transform).toBe("translate(520px, 480px)");
    expect(after[0].style.width).toBe("160px");
    expect(after[1].style.transform).toBe("translate(520px, 560px)");
    // Same elements on the page, so the page-unit boxes are unchanged.
    expect(live.outlineRects()).toEqual([
      { x: 300, y: 250, width: 80, height: 24 },
      { x: 300, y: 290, width: 80, height: 24 },
    ]);
  });

  it("outlines one tag site as many places when a `.map()` renders it", async () => {
    // The distinction the api docs make: `instances` counts places in the
    // source, `outlined` counts what is on the canvas. `<BrowseRow>` in this
    // repo is one tag inside a map over eight products; here it is three.
    await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    const result = await live.show("Chip");
    expect(result?.component.instances).toHaveLength(1);
    expect(result?.outlined).toBe(3);
    expect(boxes()).toHaveLength(3);
    expect(scroll.querySelectorAll(".cx-chip")).toHaveLength(3);
    // Each outline is on its own chip, not three boxes on one of them.
    for (const [i, chip] of [...scroll.querySelectorAll(".cx-chip")].entries()) {
      stubRect(chip, { left: 0, top: i * 10, width: 8, height: 8 });
    }
    live.onCameraWrite();
    expect(live.outlineRects().map((r) => r.y)).toEqual([0, 10, 20]);
  });

  it("outlines nested copies of one tag site separately", async () => {
    // Tree renders itself, so the two inner trees come from the SAME line and
    // one contains the other. There are three Trees on screen and three is the
    // answer; collapsing them by source line would report two.
    await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    const result = await live.show("Tree");
    expect(result?.component.instances).toHaveLength(2);
    expect(scroll.querySelectorAll(".cx-tree")).toHaveLength(3);
    expect(result?.outlined).toBe(3);
  });

  it("names the nearest component an element belongs to", async () => {
    const { labels, rows, panel } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    // A span inside a Row inside ProbePanel answers Row, not ProbePanel.
    expect(await live.componentAt(labels[0])).toBe("Row");
    expect(await live.componentAt(rows[0])).toBe("Row");
    // ProbePanel is the root: nothing renders it, so it has no instance and
    // its own section belongs to no indexed instance.
    expect(await live.componentAt(panel)).toBeNull();
  });

  it("clears for a name nothing renders", async () => {
    await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    await live.show("Row");
    expect(boxes()).toHaveLength(2);
    expect(await live.show("Nonesuch")).toBeNull();
    expect(boxes()).toHaveLength(0);
    expect(live.shown()).toBeNull();
  });

  it("stops showing an element a hot reload detached", async () => {
    const { rows } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    await live.show("Row");
    rows[0].remove();
    live.onCameraWrite();
    expect(boxes()[0].hasAttribute("data-show")).toBe(false);
    expect(live.outlineRects()).toHaveLength(1);
  });
});

describe("not fighting the canvas", () => {
  it("takes ctrl+shift-click and consumes only that press", async () => {
    const { labels } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    const seen: boolean[] = [];
    document.addEventListener("pointerdown", (e) => seen.push(e.defaultPrevented));

    press(labels[0]);
    press(labels[0], { shiftKey: true });
    press(labels[0], { altKey: true });
    press(labels[0], { ctrlKey: true });
    // Only the presses this plugin ignores reached the document at all, and
    // none of them was prevented.
    expect(seen).toEqual([false, false, false, false]);
    expect(boxes()).toHaveLength(0);

    press(labels[0], { ctrlKey: true, shiftKey: true });
    await flush();
    expect(seen).toEqual([false, false, false, false]); // consumed, never bubbled
    expect(live.shown()).toBe("Row");
    expect(boxes()).toHaveLength(2);
  });

  it("leaves the gestures inspect and the canvas already own", async () => {
    const { labels } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    // shift alone is inspect; alt is drag-duplicate; alt+ctrl+shift is nobody's
    // but is not ours either.
    for (const mod of [
      { shiftKey: true },
      { altKey: true },
      { ctrlKey: true, shiftKey: true, altKey: true },
    ]) {
      press(labels[0], mod);
      await flush();
      expect(live.shown()).toBeNull();
    }
  });

  it("does not drop the outlines on a plain click, so panning can look around", async () => {
    const { labels } = await mountProbe();
    live = createComponents(ctxFor(), loadFixture);
    await live.show("Row");
    press(labels[0]);
    press(shield);
    expect(live.shown()).toBe("Row");
    expect(boxes()).toHaveLength(2);
    // Escape is how it ends.
    expect(live.handleKey(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(boxes()).toHaveLength(0);
    // And with nothing shown, Escape belongs to the lab again.
    expect(live.handleKey(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
  });
});

describe("teardown", () => {
  it("leaves no listeners, no nodes and no style behind", async () => {
    const { labels } = await mountProbe();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");

    const view = createComponents(ctxFor(), loadFixture);
    await view.show("Row");
    expect(document.querySelectorAll("style[data-lab-components]").length).toBe(1);
    expect(host.querySelectorAll(".lc-root").length).toBe(1);
    expect(host.querySelectorAll(".lc-box").length).toBe(2);

    const added = add.mock.calls.map((c) => [c[0], c[1], c[2]]);
    expect(added.length).toBeGreaterThan(0);

    view.destroy();

    const removed = remove.mock.calls.map((c) => [c[0], c[1], c[2]]);
    for (const [type, fn, opts] of added) {
      expect(removed.some((r) => r[0] === type && r[1] === fn && r[2] === opts)).toBe(
        true,
      );
    }
    expect(document.querySelectorAll("style[data-lab-components]").length).toBe(0);
    expect(host.children.length).toBe(0);

    // The real proof the listener is gone: the chord no longer shows anything.
    press(labels[0], { ctrlKey: true, shiftKey: true });
    await flush();
    expect(view.shown()).toBeNull();
    expect(document.querySelectorAll(".lc-box").length).toBe(0);

    add.mockRestore();
    remove.mockRestore();
  });

  it("drops the shared style only when the last view goes", async () => {
    const a = createComponents(ctxFor(), loadFixture);
    const b = createComponents(ctxFor(), loadFixture);
    a.destroy();
    expect(document.querySelectorAll("style[data-lab-components]").length).toBe(1);
    b.destroy();
    expect(document.querySelectorAll("style[data-lab-components]").length).toBe(0);
  });
});

/**
 * The join, in the address space it actually runs in.
 *
 * Everything above renders React under vitest, where a stack arrives already
 * mapped back to the file — so both halves of the join speak source
 * coordinates and it works. In a browser they do not: React's `_debugStack`
 * carries coordinates in the module vite built, the index carries coordinates
 * in the file the compiler read, and the two never meet. That is why the
 * propagation view painted nothing at all in the running lab while this file
 * was green, and it is the one thing no test here could see.
 *
 * So: the same fixture, the same compiler-built index, but the fibers carry
 * the coordinates the transform really produces, served over http with the
 * transform's own map behind them.
 */
describe("the join, in the browser's coordinates", () => {
  const FIXTURE_REL = "src/lab/plugins/components/probe-fixture.tsx";
  const MODULE_URL = `http://localhost:5180/${FIXTURE_REL}?t=77`;

  type At = { line: number; column: number };

  let servedModule = "";
  let servedRows: At[] = [];
  let servedSpan: At = { line: 0, column: 0 };

  /** V8 puts a call's column at the first character of the callee. */
  function callSites(code: string, callee: string): At[] {
    const out: At[] = [];
    code.split("\n").forEach((text, i) => {
      let from = 0;
      for (;;) {
        const at = text.indexOf(callee, from);
        if (at < 0) break;
        out.push({ line: i + 1, column: at + 1 });
        from = at + 1;
      }
    });
    return out;
  }

  beforeAll(async () => {
    // The same transform vite 8 runs to serve a .tsx, under the bare filename
    // its dev maps use in `sources`.
    const out = await transformWithOxc(
      readFileSync(FIXTURE_FILE, "utf8"),
      "probe-fixture.tsx",
      { lang: "tsx", jsx: { runtime: "automatic", development: true }, sourcemap: true },
    );
    if (!out.map) throw new Error("the transform produced no source map");
    const base64 = Buffer.from(JSON.stringify(out.map), "utf8").toString("base64");
    servedModule = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
    servedRows = callSites(out.code, "_jsxDEV(Row");
    servedSpan = callSites(out.code, '_jsxDEV("span"')[0];
    if (servedRows.length !== 2 || !servedSpan) {
      throw new Error(`expected two Row calls and a span, got ${servedRows.length}`);
    }
  });

  type FakeFiber = { _debugStack: { stack: string }; return: FakeFiber | null };

  function stackAt(component: string, at: At): { stack: string } {
    return {
      stack: [
        "Error: react-stack-top-frame",
        "    at jsxDEV (http://localhost:5180/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=aa:333:13)",
        `    at ${component} (${MODULE_URL}:${at.line}:${at.column})`,
      ].join("\n"),
    };
  }

  /** A row div with its label span, both hung off fibers like React's. */
  function buildRow(at: At): { row: HTMLElement; label: HTMLElement } {
    const rowFiber: FakeFiber = { _debugStack: stackAt("ProbePanel", at), return: null };
    const row = document.createElement("div");
    row.className = "cx-row";
    Object.assign(row, { __reactFiber$served: rowFiber });
    const label = document.createElement("span");
    label.className = "cx-label";
    Object.assign(label, {
      __reactFiber$served: { _debugStack: stackAt("Row", servedSpan), return: rowFiber },
    });
    row.appendChild(label);
    scroll.appendChild(row);
    return { row, label };
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

  beforeEach(() => {
    resetSourceMaps();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSourceMaps();
  });

  it("outlines the rows the served coordinates point at, rather than nothing", async () => {
    // The gap the shipped bug fell into: the compiler says line 39, the module
    // vite serves says something else entirely, and a key built from the
    // second can never match one built from the first.
    const indexed = FIXTURE_INDEX.components.find((c) => c.name === "Row");
    expect(indexed?.instances.map((i) => i.line)).toEqual([39, 40]);
    expect(indexed?.instances[0].file).toBe(`${LAB_PACKAGE_DIR}/${FIXTURE_REL}`);
    expect(servedRows.map((r) => r.line)).not.toEqual([39, 40]);

    serveModule();
    buildRow(servedRows[0]);
    buildRow(servedRows[1]);
    live = createComponents(ctxFor(), loadFixture);

    const result = await live.show("Row");
    expect(result?.component.name).toBe("Row");
    expect(result?.outlined).toBe(2);
    expect(boxes()).toHaveLength(2);
  });

  it("names the component a served element belongs to, nearest owner first", async () => {
    serveModule();
    const { row, label } = buildRow(servedRows[0]);
    live = createComponents(ctxFor(), loadFixture);
    // The span's own frame is the `<span>` inside Row, which is not an
    // instance; the answer comes from climbing to the fiber that made the Row.
    expect(await live.componentAt(label)).toBe("Row");
    expect(await live.componentAt(row)).toBe("Row");
  });

  it("outlines nothing rather than the wrong thing when the map cannot be read", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    buildRow(servedRows[0]);
    buildRow(servedRows[1]);
    live = createComponents(ctxFor(), loadFixture);
    const result = await live.show("Row");
    // The component is real, so it is still "shown" — there is just nothing on
    // screen that can be proven to be one of its instances.
    expect(result?.outlined).toBe(0);
    expect(boxes()).toHaveLength(0);
  });
});

describe("the published api", () => {
  it("documents only methods that exist", () => {
    const docs = plugin.describe ?? [];
    expect(docs.length).toBeGreaterThan(0);
    const proto = ComponentsView.prototype as unknown as Record<string, unknown>;
    expect(docs.filter((d) => typeof proto[d.name] !== "function").map((d) => d.name)).toEqual(
      [],
    );
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
