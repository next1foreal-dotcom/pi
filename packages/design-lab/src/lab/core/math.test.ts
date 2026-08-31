import { describe, it, expect } from "vitest";
import {
  zoomToBounds,
  cameraCentering,
  cameraTransform,
  boundsOf,
  FIT_Z_MIN,
  FIT_Z_MAX,
} from "./math";

/*
 * Verifier's measured scene:
 *   viewport  = 1280 × 720
 *   screens   = playground (0,0,1440×900) + product-list (1640,0,1440×900)
 *   bounds    = { x:0, y:0, width:3080, height:900 }
 *
 * Expected per spec formula:
 *   inset     = min(96, 1280 * 0.28) = 96
 *   z         = min((1280-192)/3080, (720-192)/900) ≈ 0.3532
 *   center    = (1540, 450)
 *   camera.x  = 1280 / (2 * z) - 1540
 *   camera.y  = 720  / (2 * z) - 450
 */

const VIEWPORT = { width: 1280, height: 720 };
const PLAYGROUND = { x: 0, y: 0, width: 1440, height: 900 };
const PRODUCT_LIST = { x: 1640, y: 0, width: 1440, height: 900 };

describe("boundsOf", () => {
  it("computes bounding box of two screens", () => {
    const b = boundsOf([PLAYGROUND, PRODUCT_LIST]);
    expect(b).toEqual({ x: 0, y: 0, width: 3080, height: 900 });
  });
});

describe("zoomToBounds – fit all screens", () => {
  const bounds = { x: 0, y: 0, width: 3080, height: 900 };
  const cam = zoomToBounds(bounds, VIEWPORT);

  it("produces z ≈ 0.353 (±0.01)", () => {
    expect(cam.z).toBeGreaterThan(0.343);
    expect(cam.z).toBeLessThan(0.363);
  });

  it("z is NOT clamped to FIT_Z_MIN", () => {
    expect(cam.z).not.toBeCloseTo(FIT_Z_MIN, 4);
  });

  it("maps bounds center to viewport center (±1px)", () => {
    // bounds center in page coords
    const cx = bounds.x + bounds.width / 2;  // 1540
    const cy = bounds.y + bounds.height / 2; // 450
    // screen position = (page + camera) * z
    const sx = (cx + cam.x) * cam.z;
    const sy = (cy + cam.y) * cam.z;
    expect(sx).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(sy).toBeCloseTo(VIEWPORT.height / 2, 0);
  });
});

describe("zoomToBounds – lock into single screen (product-list)", () => {
  const cam = zoomToBounds(PRODUCT_LIST, VIEWPORT);

  it("produces z = min((1280-192)/1440, (720-192)/900) ≈ 0.587, clamped ≤ 1", () => {
    // z_x = (1280-192)/1440 = 1088/1440 ≈ 0.7556
    // z_y = (720-192)/900 = 528/900 ≈ 0.5867
    // z = min(z_x, z_y) = 0.5867
    expect(cam.z).toBeGreaterThan(0.576);
    expect(cam.z).toBeLessThan(0.597);
    expect(cam.z).toBeLessThanOrEqual(FIT_Z_MAX);
  });

  it("maps screen center to viewport center (±1px)", () => {
    const cx = PRODUCT_LIST.x + PRODUCT_LIST.width / 2;  // 2360
    const cy = PRODUCT_LIST.y + PRODUCT_LIST.height / 2; // 450
    const sx = (cx + cam.x) * cam.z;
    const sy = (cy + cam.y) * cam.z;
    expect(sx).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(sy).toBeCloseTo(VIEWPORT.height / 2, 0);
  });
});

describe("zoomToBounds – lock into playground", () => {
  const cam = zoomToBounds(PLAYGROUND, VIEWPORT);

  it("produces z ≈ 0.587", () => {
    // same aspect ratio as product-list, same z
    expect(cam.z).toBeGreaterThan(0.576);
    expect(cam.z).toBeLessThan(0.597);
  });

  it("maps screen center to viewport center (±1px)", () => {
    const cx = PLAYGROUND.x + PLAYGROUND.width / 2;  // 720
    const cy = PLAYGROUND.y + PLAYGROUND.height / 2; // 450
    const sx = (cx + cam.x) * cam.z;
    const sy = (cy + cam.y) * cam.z;
    expect(sx).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(sy).toBeCloseTo(VIEWPORT.height / 2, 0);
  });
});

describe("cameraTransform produces correct CSS", () => {
  it("includes scale when z != 1", () => {
    const cam = { x: 100, y: 200, z: 0.5 };
    const t = cameraTransform(cam);
    expect(t).toBe("scale(0.5) translate(100px, 200px)");
  });

  it("omits scale when z == 1", () => {
    const cam = { x: 10, y: 20, z: 1 };
    const t = cameraTransform(cam);
    expect(t).toBe("translate(10px, 20px)");
  });
});

describe("cameraCentering roundtrip", () => {
  it("puts target page point at viewport center", () => {
    const target = { x: 1540, y: 450 };
    const z = 0.353;
    const cam = cameraCentering(target, z, VIEWPORT);
    // screen = (page + camera) * z
    const sx = (target.x + cam.x) * cam.z;
    const sy = (target.y + cam.y) * cam.z;
    expect(sx).toBeCloseTo(VIEWPORT.width / 2, 1);
    expect(sy).toBeCloseTo(VIEWPORT.height / 2, 1);
  });
});
