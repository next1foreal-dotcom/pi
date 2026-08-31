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
});
