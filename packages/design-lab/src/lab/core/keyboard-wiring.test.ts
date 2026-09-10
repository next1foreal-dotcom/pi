// @vitest-environment jsdom

/**
 * Full-chain integration test: render InteractionLab in jsdom (wrapped in
 * StrictMode like the real app), dispatch a real KeyboardEvent on window,
 * assert the selection state changes.
 *
 * This is the "接线存在" permanent guard — the 53 pure dispatch tests
 * cannot catch a listener that never fires.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

// ────────────────────────── Browser API mocks ───────────────────────────

// ResizeObserver doesn't exist in jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

// matchMedia stub — prefersReducedMotion() uses it
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Canvas 2D context stub — paintPixelGrid & ruler draw need one
const noop = () => {};
const mockCtx = {
  setTransform: noop,
  fillRect: noop,
  fillText: noop,
  beginPath: noop,
  moveTo: noop,
  lineTo: noop,
  stroke: noop,
  save: noop,
  restore: noop,
  translate: noop,
  rotate: noop,
  clearRect: noop,
  strokeStyle: "",
  fillStyle: "",
  font: "",
};
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
  mockCtx as unknown as CanvasRenderingContext2D,
);

// ────────────────────────── Imports (after mocks) ───────────────────────

import { InteractionLab, __keyboardListenerActive } from "./lab-view";
import { SCREENS } from "../screens";
import * as kd from "./keyboard-dispatch";
import { getCamera } from "./camera";

// ────────────────────────── Helpers ─────────────────────────────────────

function dispatchKey(key: string, code?: string, mods?: Partial<KeyboardEventInit>) {
  return window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: code ?? key,
      bubbles: true,
      cancelable: true,
      ...mods,
    }),
  );
}

// ────────────────────────── Tests ───────────────────────────────────────

describe("keyboard wiring (full chain, jsdom + StrictMode)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    dispatchSpy = vi.spyOn(kd, "dispatchLabKey");

    // Render inside StrictMode, same as the real app (src/main.tsx)
    await act(() => {
      root.render(
        createElement(StrictMode, null, createElement(InteractionLab)),
      );
    });
  });

  afterAll(() => {
    dispatchSpy.mockRestore();
    act(() => root.unmount());
    container.remove();
  });

  // ── Layer 0: preconditions ──────────────────────────────────────────

  it("precondition: SCREENS registry has entries", () => {
    expect(SCREENS.length).toBeGreaterThan(0);
  });

  it("precondition: keyboard listener is registered after mount", () => {
    expect(__keyboardListenerActive).toBe(true);
  });

  // ── Layer 1: dispatch function is reached ───────────────────────────

  it("dispatchLabKey is called when Tab is dispatched on window", async () => {
    dispatchSpy.mockClear();

    await act(() => {
      dispatchKey("Tab");
    });

    expect(dispatchSpy).toHaveBeenCalled();
    const result = dispatchSpy.mock.results[0];
    expect(result?.type).toBe("return");
    expect(result?.value).toEqual({ action: "cycle-select", direction: 1 });
  });

  // ── Layer 2: DOM observable — ring element appears after Tab ────────

  it("Tab causes ring element to appear on one screen frame", async () => {
    // Reset selection via Esc first
    await act(() => { dispatchKey("Escape"); });

    // Narrow to groups that are screen frames (inside the layer div).
    // Chrome items also have data-screen-id but live in .chrome div.
    const layerGroups = [...container.querySelectorAll("[data-screen-id]")].filter(
      (el) => el.parentElement?.getAttribute("data-ruler-host") == null
          && el.querySelector("[data-screen-scroll]"),
    );
    expect(layerGroups.length).toBeGreaterThan(0);

    const childCountsBefore = layerGroups.map(
      (g) => g.firstElementChild!.children.length,
    );

    // Tab
    await act(() => { dispatchKey("Tab"); });

    // One frame's child count should have increased (ring div added)
    const childCountsAfter = layerGroups.map(
      (g) => g.firstElementChild!.children.length,
    );
    const gained = childCountsAfter.some(
      (count, i) => count > childCountsBefore[i],
    );
    expect(gained).toBe(true);
  });

  // ── Layer 3: Tab + Enter → data-mode changes to "focus" ────────────

  it("Tab then Enter locks into the selected screen", async () => {
    // Reset to explore
    await act(() => { dispatchKey("Escape"); });
    await act(() => { dispatchKey("Escape"); });
    const rootEl = container.querySelector("[data-mode]");
    expect(rootEl?.getAttribute("data-mode")).toBe("explore");

    // Tab to select
    await act(() => { dispatchKey("Tab"); });

    // Enter to lock in
    await act(() => { dispatchKey("Enter"); });

    // data-mode should now be "focus"
    expect(rootEl?.getAttribute("data-mode")).toBe("focus");
  });

  // ── Layer 4: labels intercept chain (after notes) ─────────────────

  async function backToExplore() {
    await act(() => {
      dispatchKey("Escape");
    });
    await act(() => {
      dispatchKey("Escape");
    });
  }

  it("Shift+L spawns a label on the labels host", async () => {
    await backToExplore();
    await act(() => {
      dispatchKey("l", "KeyL", { shiftKey: true });
    });
    const labels = container.querySelectorAll("[data-labels-host] .lb-label");
    expect(labels.length).toBeGreaterThan(0);
  });

  it("Delete with a selected label removes the label, not a screen", async () => {
    await backToExplore();
    const screensBefore = container.querySelectorAll(
      "[data-screen-scroll]",
    ).length;
    expect(screensBefore).toBeGreaterThan(0);

    await act(() => {
      dispatchKey("Tab");
    });
    await act(() => {
      dispatchKey("l", "KeyL", { shiftKey: true });
    });
    const labelsBefore = container.querySelectorAll(
      "[data-labels-host] .lb-label",
    ).length;
    expect(labelsBefore).toBeGreaterThan(0);

    dispatchSpy.mockClear();
    await act(() => {
      dispatchKey("Delete");
    });

    expect(
      container.querySelectorAll("[data-labels-host] .lb-label").length,
    ).toBe(labelsBefore - 1);
    expect(container.querySelectorAll("[data-screen-scroll]").length).toBe(
      screensBefore,
    );
    const deletedScreen = dispatchSpy.mock.results.some(
      (r: { type: string; value?: { action?: string } }) =>
        r.type === "return" && r.value?.action === "delete-screen",
    );
    expect(deletedScreen).toBe(false);
  });

  it("Delete with no label selected reaches lab delete-screen", async () => {
    await backToExplore();
    await act(() => {
      document.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    await act(() => {
      dispatchKey("Tab");
    });
    dispatchSpy.mockClear();
    await act(() => {
      dispatchKey("Delete");
    });
    expect(dispatchSpy).toHaveBeenCalled();
    const reachedLab = dispatchSpy.mock.results.some(
      (r: { type: string; value?: { action?: string } }) =>
        r.type === "return" && r.value?.action === "delete-screen",
    );
    expect(reachedLab).toBe(true);
  });

  it("P then Escape leaves explore selection and camera as they were", async () => {
    await backToExplore();
    await act(() => {
      dispatchKey("Tab");
    });
    const rootEl = container.querySelector("[data-mode]");
    expect(rootEl?.getAttribute("data-mode")).toBe("explore");
    const camBefore = { ...getCamera() };
    dispatchSpy.mockClear();

    await act(() => {
      dispatchKey("i", "KeyI");
    });
    expect(rootEl?.hasAttribute("data-pick")).toBe(true);
    expect(rootEl?.getAttribute("data-mode")).toBe("explore");
    expect(getCamera()).toEqual(camBefore);

    await act(() => {
      dispatchKey("Escape");
    });
    expect(rootEl?.hasAttribute("data-pick")).toBe(false);
    expect(rootEl?.getAttribute("data-mode")).toBe("explore");
    expect(getCamera()).toEqual(camBefore);

    // Selection survived: Enter still locks into the screen Tab picked.
    await act(() => {
      dispatchKey("Enter");
    });
    expect(rootEl?.getAttribute("data-mode")).toBe("focus");

    await backToExplore();
  });

  /**
   * Escape lets go of the element, not only of the screen.
   *
   * Before this, `deselect` dropped the SCREEN and `exit-one` changed the
   * mode, and the element selection outlived both — so backing out of a
   * screen left its outline, its toolbar and the properties panel standing
   * over a canvas you had just left. 「esc 退出来的时候就不该选中了吧」.
   *
   * Driven end to end rather than through `dispatchLabKey`, because the pure
   * dispatcher cannot see whether anything is wired to the answer it returns.
   */
  function inspectApi(): {
    selectElement(el: Element): unknown;
    selection(): unknown;
  } {
    const api = window.lab?.plugin("inspect") as {
      selectElement(el: Element): unknown;
      selection(): unknown;
    };
    return api;
  }

  function someScreenElement(): Element | null {
    const scroll = container.querySelector("[data-screen-scroll]");
    return scroll?.querySelector("*") ?? null;
  }

  it("Escape lets go of the element, in explore", async () => {
    await backToExplore();
    const el = someScreenElement();
    expect(el, "the fixture screens rendered something to select").not.toBeNull();
    inspectApi().selectElement(el as Element);
    expect(inspectApi().selection()).not.toBeNull();

    await act(() => {
      dispatchKey("Escape");
    });
    expect(inspectApi().selection()).toBeNull();
  });

  it("and tells the panels, which have no other way to find out", async () => {
    // Both re-read on a press and on a camera write, which is the right
    // bargain for a selection that only ever changed from a click. Escape is
    // neither: measured 2026-09-10, the properties panel sat there afterwards
    // still describing an `<h1>` that nothing was selecting, while its own
    // `state()` already said null. The panel was right; it had never been
    // asked.
    //
    // Asserted on the call and not on the panel's DOM, because the properties
    // panel needs a resolvable source location to show at all and jsdom has
    // none — a `data-show` assertion here passes whether the wiring exists or
    // not, which is exactly the kind of green that means nothing.
    await backToExplore();
    const props = window.lab?.plugin("properties") as { refresh: () => void };
    const tree = window.lab?.plugin("layers") as { refresh: () => void };
    const onProps = vi.spyOn(props, "refresh");
    const onTree = vi.spyOn(tree, "refresh");

    await act(() => {
      dispatchKey("Escape");
    });
    expect(onProps).toHaveBeenCalled();
    expect(onTree).toHaveBeenCalled();
    onProps.mockRestore();
    onTree.mockRestore();
  });

  it("Delete does not reach past a held element to its screen", async () => {
    // The hazard: selecting an element moves the canvas's own selection to
    // that element's SCREEN, and `delete-screen` reads exactly that. Measured
    // before the guard — with an h1 selected, `selectedId` was the screen, and
    // Delete would have moved its whole folder to `.lab-trash`.
    //
    // Asserted on the action never reaching the lab's delete, because actually
    // letting it through in a test would delete a real fixture directory.
    await backToExplore();
    await act(() => {
      dispatchKey("Tab");
    });
    const el = someScreenElement();
    inspectApi().selectElement(el as Element);
    expect(inspectApi().selection()).not.toBeNull();
    dispatchSpy.mockClear();

    const deleted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      if (String(url).includes("/__lab-fs/delete")) deleted.push(String(url));
      return Promise.resolve({ json: () => Promise.resolve({ ok: false }) } as Response);
    }) as typeof fetch;

    await act(() => {
      dispatchKey("Delete");
    });
    globalThis.fetch = realFetch;
    const reached = dispatchSpy.mock.results.some(
      (r: { type: string; value?: { action?: string } }) =>
        r.type === "return" && r.value?.action === "delete-screen",
    );
    // The dispatcher still answers "delete-screen" — it knows nothing about
    // elements. The lab is what refuses.
    expect(reached).toBe(true);
    // And refusing means the request is never made. Asserted on the call and
    // not on the DOM: `deleteScreen` talks to the dev server, which is absent
    // here, so a "the screen is still on the page" check passes whether the
    // guard exists or not.
    expect(deleted).toEqual([]);
    await backToExplore();
  });

  it("and on the way out of a screen", async () => {
    await backToExplore();
    await act(() => {
      dispatchKey("Tab");
    });
    await act(() => {
      dispatchKey("Enter");
    });
    const rootEl = container.querySelector("[data-mode]");
    expect(rootEl?.getAttribute("data-mode")).toBe("focus");

    const el = someScreenElement();
    inspectApi().selectElement(el as Element);
    expect(inspectApi().selection()).not.toBeNull();

    await act(() => {
      dispatchKey("Escape");
    });
    expect(rootEl?.getAttribute("data-mode")).toBe("explore");
    expect(inspectApi().selection()).toBeNull();
    await backToExplore();
  });
});
