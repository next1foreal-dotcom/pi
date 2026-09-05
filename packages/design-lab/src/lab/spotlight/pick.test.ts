// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { Camera } from "../core/types";
import { createPickTool, pickableFrom } from "./pick";

const SCREEN_STACK = `Error
    at PlaygroundScreen (http://localhost:5180/src/screens/playground/screen.tsx:19:25)`;

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

  it("说这里 posts a note whose source file is repo-relative", () => {
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
    (btn as HTMLButtonElement).click();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.source).toEqual({
      file: "src/screens/playground/screen.tsx",
      line: 19,
      col: 25,
      component: "PlaygroundScreen",
    });
    expect(JSON.stringify(spawned[0])).not.toContain("http://localhost:5180");
    pick.destroy();
  });
});
