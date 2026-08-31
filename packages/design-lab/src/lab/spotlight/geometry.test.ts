import { describe, expect, it } from "vitest";
import { FIT_Z_MAX, zoomToBounds } from "../core/math";
import {
  MIN_SPOTLIGHT_SIZE,
  clientRectToCanvas,
  isValidRect,
  minFrameRect,
  resolveSpotlightTarget,
  spotlightCamera,
  unionRects,
} from "./geometry";

const VIEWPORT = { width: 1280, height: 720 };
const SCREEN = { x: 1640, y: 0, width: 1440, height: 900 };

describe("unionRects", () => {
  it("returns the bounding union of two rects", () => {
    expect(
      unionRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 5, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });

  it("returns null for an empty list", () => {
    expect(unionRects([])).toBeNull();
  });

  it("skips invalid rects when unioning", () => {
    expect(
      unionRects([
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 2, y: 2, width: 4, height: 4 },
      ]),
    ).toEqual({ x: 2, y: 2, width: 4, height: 4 });
  });
});

describe("isValidRect / resolveSpotlightTarget", () => {
  it("rejects zero, negative, and non-finite boxes", () => {
    expect(isValidRect({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
    expect(isValidRect({ x: 0, y: 0, width: 10, height: -1 })).toBe(false);
    expect(isValidRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toBe(
      false,
    );
    expect(isValidRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
  });

  it("falls back to the screen frame when the union is empty or invalid", () => {
    expect(resolveSpotlightTarget([], SCREEN)).toEqual(SCREEN);
    expect(
      resolveSpotlightTarget(
        [{ x: Number.NaN, y: 0, width: 1, height: 1 }],
        SCREEN,
      ),
    ).toEqual(SCREEN);
  });
});

describe("minFrameRect / zoom cap (lockInto convention)", () => {
  it("grows a 2px node around its center to the minimum framing size", () => {
    const framed = minFrameRect({ x: 10, y: 20, width: 2, height: 2 });
    expect(framed.width).toBeGreaterThanOrEqual(MIN_SPOTLIGHT_SIZE);
    expect(framed.height).toBeGreaterThanOrEqual(MIN_SPOTLIGHT_SIZE);
    expect(framed.x + framed.width / 2).toBeCloseTo(11, 5);
    expect(framed.y + framed.height / 2).toBeCloseTo(21, 5);
  });

  it("does not zoom past FIT_Z_MAX on a 2px node", () => {
    const cam = spotlightCamera(
      { x: 10, y: 20, width: 2, height: 2 },
      VIEWPORT,
    );
    expect(cam.z).toBeLessThanOrEqual(FIT_Z_MAX);
  });

  it("frames a full screen the same way lockInto / zoomToBounds does", () => {
    expect(spotlightCamera(SCREEN, VIEWPORT)).toEqual(
      zoomToBounds(SCREEN, VIEWPORT),
    );
  });
});

describe("clientRectToCanvas", () => {
  it("maps a client rect through camera + origin into page coordinates", () => {
    const cam = { x: 10, y: 20, z: 2 };
    const origin = { x: 5, y: 5 };
    const page = clientRectToCanvas(
      { left: 25, top: 45, right: 45, bottom: 65 },
      cam,
      origin,
    );
    // screenToPage: (client - origin) / z - camera
    expect(page.x).toBeCloseTo((25 - 5) / 2 - 10, 5);
    expect(page.y).toBeCloseTo((45 - 5) / 2 - 20, 5);
    expect(page.width).toBeCloseTo(20 / 2, 5);
    expect(page.height).toBeCloseTo(20 / 2, 5);
  });
});
