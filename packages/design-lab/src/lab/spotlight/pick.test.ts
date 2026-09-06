// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc } from "vite";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Camera } from "../core/types";
import { primeSourceMaps, resetSourceMaps } from "../sourcemap/cache";
import { createPickTool, pickableFrom } from "./pick";

/**
 * The stack fed to pick here is the one a BROWSER produces: coordinates in the
 * module vite served, not in the file on disk. This test used to hand-write
 * those numbers and assert them straight back out, which wrote the shipped bug
 * down as an expectation — a note pinned in the lab carried a line that does
 * not exist in the source file it names.
 *
 * So the module is transformed for real, the served coordinates are read out
 * of that transform mechanically, and the map served alongside it is what has
 * to turn them back into the tag's real position. Nothing here is hand-written,
 * which is the only reason it can fail when the mapping stops happening.
 */
const SCREEN_URL =
  "http://localhost:5180/src/screens/playground/screen.tsx";
const FIXTURE = "src/lab/plugins/inspect/probe-fixture.tsx";
/** Where `<button` really begins in that fixture, 1-based. */
const SOURCE_TAG = { line: 9, col: 7 };

let SCREEN_STACK = "";
let servedModule = "";

function callSite(code: string, callee: string): { line: number; col: number } {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(callee);
    if (at !== -1) return { line: i + 1, col: at + 1 };
  }
  throw new Error(`no ${callee} in the transformed module`);
}

beforeAll(async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "..", "..", "..", FIXTURE), "utf8");
  const out = await transformWithOxc(source, "screen.tsx", {
    lang: "tsx",
    jsx: { runtime: "automatic", development: true },
    sourcemap: true,
  });
  if (!out.map) throw new Error("the transform produced no source map");
  const base64 = Buffer.from(JSON.stringify(out.map), "utf8").toString("base64");
  servedModule = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
  const served = callSite(out.code, '_jsxDEV("button"');
  SCREEN_STACK = `Error\n    at PlaygroundScreen (${SCREEN_URL}:${served.line}:${served.col})`;
});

beforeEach(() => {
  resetSourceMaps();
  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const hit = String(input).startsWith(SCREEN_URL);
    return Promise.resolve(
      new Response(hit ? servedModule : "", { status: hit ? 200 : 404 }),
    );
  });
});

const CAM: Camera = { x: 10, y: 20, z: 0.5 };

function screenTree(): {
  root: HTMLDivElement;
  target: HTMLButtonElement;
  notes: HTMLDivElement;
  labels: HTMLDivElement;
  ruler: HTMLDivElement;
  chrome: HTMLDivElement;
} {
  const root = document.createElement("div");
  root.setAttribute("data-mode", "explore");
  const group = document.createElement("div");
  group.setAttribute("data-screen-id", "playground");
  const scroll = document.createElement("div");
  scroll.setAttribute("data-screen-scroll", "playground");
  const target = document.createElement("button");
  target.textContent = "Buy";
  Object.assign(target, {
    __reactFiber$test: { _debugStack: SCREEN_STACK, return: null },
  });
  Object.defineProperty(target, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 100,
      y: 80,
      left: 100,
      top: 80,
      right: 180,
      bottom: 120,
      width: 80,
      height: 40,
      toJSON() {},
    }),
  });
  scroll.appendChild(target);
  group.appendChild(scroll);
  const notes = document.createElement("div");
  notes.setAttribute("data-notes-host", "");
  const noteChild = document.createElement("div");
  noteChild.className = "sn-note";
  notes.appendChild(noteChild);
  const labels = document.createElement("div");
  labels.setAttribute("data-labels-host", "");
  const labelChild = document.createElement("div");
  labelChild.className = "lb-label";
  labels.appendChild(labelChild);
  const ruler = document.createElement("div");
  ruler.setAttribute("data-ruler-host", "");
  const tick = document.createElement("canvas");
  ruler.appendChild(tick);
  const chrome = document.createElement("div");
  chrome.setAttribute("data-lab-chrome", "");
  const hudBtn = document.createElement("button");
  chrome.appendChild(hudBtn);
  root.append(group, notes, labels, ruler, chrome);
  document.body.appendChild(root);
  return { root, target, notes, labels, ruler, chrome };
}

describe("pickableFrom skips lab chrome", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not pick inside notes, labels, ruler, or lab chrome hosts", () => {
    const { notes, labels, ruler, chrome } = screenTree();
    expect(pickableFrom(notes.querySelector(".sn-note"))).toBeNull();
    expect(pickableFrom(labels.querySelector(".lb-label"))).toBeNull();
    expect(pickableFrom(ruler.querySelector("canvas"))).toBeNull();
    expect(pickableFrom(chrome.querySelector("button"))).toBeNull();
  });

  it("does pick an element inside a screen", () => {
    const { target } = screenTree();
    expect(pickableFrom(target)).toBe(target);
  });
});

describe("pick tool", () => {
  const spawned: {
    x: number;
    y: number;
    source?: { file: string; line: number; col: number; component: string | null };
  }[] = [];
  let host: HTMLDivElement;
  let tree: ReturnType<typeof screenTree>;
  let camera: Camera;

  afterEach(() => {
    spawned.length = 0;
    document.body.innerHTML = "";
  });

  function mount() {
    tree = screenTree();
    host = document.createElement("div");
    tree.root.appendChild(host);
    camera = { ...CAM };
    return createPickTool({
      host,
      getRoot: () => tree.root,
      getOrigin: () => ({ x: 0, y: 0 }),
      getCamera: () => camera,
      spawnNote: (init) => {
        spawned.push({
          x: init.x,
          y: init.y,
          source: init.source ?? undefined,
        });
      },
    });
  }

  it("enter/exit leave data-mode and camera untouched", () => {
    const pick = mount();
    const before = { ...camera };
    pick.enter();
    expect(tree.root.getAttribute("data-mode")).toBe("explore");
    expect(camera).toEqual(before);
    pick.exit();
    expect(tree.root.getAttribute("data-mode")).toBe("explore");
    expect(tree.root.hasAttribute("data-pick")).toBe(false);
    expect(camera).toEqual(before);
    pick.destroy();
  });

  it("Escape exits pick without changing camera", () => {
    const pick = mount();
    const before = { ...camera };
    pick.enter();
    const consumed = pick.handleKey(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(consumed).toBe(true);
    expect(pick.isActive()).toBe(false);
    expect(camera).toEqual(before);
    pick.destroy();
  });

  it("说这里 posts a note whose source file is repo-relative", async () => {
    const pick = mount();
    pick.enter();
    tree.target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 110,
        clientY: 90,
      }),
    );
    const btn = host.querySelector("[data-pick-speak]");
    expect(btn).toBeInstanceOf(HTMLButtonElement);
    expect(btn?.textContent).toBe("说这里");
    // The lab primes this the same way, off the screens it is about to walk;
    // pick resolves synchronously and must find the map already parsed.
    await primeSourceMaps([SCREEN_URL]);
    (btn as HTMLButtonElement).click();
    expect(spawned).toHaveLength(1);
    // Repo-relative, which is what the name of this test always claimed and
    // what it did not assert: the dev server serves this package at `/`, so a
    // frame reading `/src/...` is `packages/design-lab/src/...` on disk. She
    // opens what lands here, so the prefix is the difference between a path and
    // a guess.
    expect(spawned[0]?.source).toEqual({
      file: "packages/design-lab/src/screens/playground/screen.tsx",
      line: SOURCE_TAG.line,
      col: SOURCE_TAG.col,
      component: "PlaygroundScreen",
    });
    expect(JSON.stringify(spawned[0])).not.toContain("http://localhost:5180");
    pick.destroy();
  });
});

describe("pick chip placement", () => {
  const spawned: {
    x: number;
    y: number;
    source?: { file: string; line: number; col: number; component: string | null };
  }[] = [];
  let host: HTMLDivElement;
  let tree: ReturnType<typeof screenTree>;
  let camera: Camera;

  afterEach(() => {
    spawned.length = 0;
    document.body.innerHTML = "";
  });

  function stubRect(
    el: Element,
    box: { top: number; left: number; width: number; height: number },
  ) {
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: box.left,
        y: box.top,
        left: box.left,
        top: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        width: box.width,
        height: box.height,
        toJSON() {},
      }),
    });
  }

  function mount() {
    tree = screenTree();
    host = document.createElement("div");
    tree.root.appendChild(host);
    camera = { ...CAM };
    return createPickTool({
      host,
      getRoot: () => tree.root,
      getOrigin: () => ({ x: 0, y: 0 }),
      getCamera: () => camera,
      spawnNote: (init) => {
        spawned.push({
          x: init.x,
          y: init.y,
          source: init.source ?? undefined,
        });
      },
    });
  }

  function selectTarget(pick: ReturnType<typeof createPickTool>) {
    pick.enter();
    tree.target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: 110,
        clientY: 90,
      }),
    );
    return host.querySelector("[data-pick-overlay]");
  }

  it("flips the chip below an element parked against the frame name", () => {
    const pick = mount();
    const frame = tree.root.querySelector("[data-screen-id]");
    if (!frame) throw new Error("no frame");
    stubRect(frame, { top: 400, left: 80, width: 800, height: 600 });
    stubRect(tree.target, { top: 408, left: 200, width: 80, height: 40 });
    const box = selectTarget(pick);
    expect(box?.hasAttribute("data-flip")).toBe(true);
    pick.destroy();
  });

  it("keeps the chip above an element with room under the frame name", () => {
    const pick = mount();
    const frame = tree.root.querySelector("[data-screen-id]");
    if (!frame) throw new Error("no frame");
    stubRect(frame, { top: 400, left: 80, width: 800, height: 600 });
    stubRect(tree.target, { top: 700, left: 200, width: 80, height: 40 });
    const box = selectTarget(pick);
    expect(box?.hasAttribute("data-flip")).toBe(false);
    pick.destroy();
  });

  it("clamps the chip to the right edge when a centred chip would run past it", () => {
    const pick = mount();
    const frame = tree.root.querySelector("[data-screen-id]");
    if (!frame) throw new Error("no frame");
    stubRect(frame, { top: 400, left: 80, width: 800, height: 600 });
    stubRect(tree.target, {
      top: 700,
      left: window.innerWidth - 40,
      width: 80,
      height: 40,
    });
    const box = selectTarget(pick);
    expect(box?.hasAttribute("data-tb-right")).toBe(true);
    expect(box?.hasAttribute("data-tb-left")).toBe(false);
    pick.destroy();
  });

  it("clamps the chip to the left edge when a centred chip would run off it", () => {
    const pick = mount();
    const frame = tree.root.querySelector("[data-screen-id]");
    if (!frame) throw new Error("no frame");
    stubRect(frame, { top: 400, left: 80, width: 800, height: 600 });
    stubRect(tree.target, { top: 700, left: 0, width: 30, height: 40 });
    const box = selectTarget(pick);
    expect(box?.hasAttribute("data-tb-left")).toBe(true);
    expect(box?.hasAttribute("data-tb-right")).toBe(false);
    pick.destroy();
  });
});
