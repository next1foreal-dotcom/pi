import {
  INTERACTIVE_Z_MAX,
  INTERACTIVE_Z_MIN,
  clamp,
  nextZoomStep,
  panBy,
  zoomAt,
} from "./math";
import { getCamera, setCameraValue } from "./camera";
import type { Point } from "./types";

export type CanvasInputHandlers = {
  getOrigin: () => Point;
  getViewport: () => { width: number; height: number };
  isLocked: () => boolean;
  isFill: () => boolean;
  onGestureStart: () => void;
  onGestureMove: () => void;
  onPointerDown: (e: PointerEvent) => boolean;
  onBackgroundClick: () => void;
  onFillPinch: () => void;
  lastPointer: { x: number; y: number };
};

function wheelDelta(e: WheelEvent): { dx: number; dy: number } {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 800 : 1;
  return { dx: e.deltaX * scale, dy: e.deltaY * scale };
}

export function bindCanvasInput(
  root: HTMLElement,
  h: CanvasInputHandlers,
): () => void {
  let panning = false;
  let panPointer = 0;
  let lastX = 0;
  let lastY = 0;
  let space = false;

  const localPoint = (e: { clientX: number; clientY: number }): Point => {
    const o = h.getOrigin();
    return { x: e.clientX - o.x, y: e.clientY - o.y };
  };

  const zoomBy = (p: Point, deltaY: number) => {
    const delta = clamp(deltaY, -10, 10) / 100;
    const cam = getCamera();
    const z2 = clamp(cam.z * (1 - delta), INTERACTIVE_Z_MIN, INTERACTIVE_Z_MAX);
    if (z2 === cam.z) return;
    setCameraValue(zoomAt(cam, p, z2));
  };

  const onWheel = (e: WheelEvent) => {
    const locked = h.isLocked();
    const fill = h.isFill();
    const pinch = e.ctrlKey || e.metaKey;
    if (fill && pinch) {
      e.preventDefault();
      h.onFillPinch();
      return;
    }
    if (locked && !pinch) return;
    e.preventDefault();
    h.onGestureStart();
    const { dx, dy } = wheelDelta(e);
    if (pinch) {
      zoomBy(localPoint(e), dy);
    } else if (e.shiftKey) {
      setCameraValue(panBy(getCamera(), dy, 0));
    } else {
      setCameraValue(panBy(getCamera(), -dx, -dy));
    }
    h.onGestureMove();
  };

  const onPointerDown = (e: PointerEvent) => {
    h.lastPointer.x = e.clientX;
    h.lastPointer.y = e.clientY;
    if (h.isLocked()) {
      if (e.button === 0) {
        const t = e.target;
        if (
          t instanceof Element &&
          !t.closest("[data-screen-id]") &&
          !t.closest("[data-lab-chrome]")
        ) {
          h.onBackgroundClick();
        }
      }
      if (h.onPointerDown(e)) return;
      return;
    }
    // Middle-drag and space-drag pan from anywhere. A plain left press pans
    // only where nothing else claims it — see the handle's onPointerDown.
    const forcePan = space || e.button === 1;
    if (!forcePan && h.onPointerDown(e)) return;
    if (h.isLocked()) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    panning = true;
    panPointer = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    root.setPointerCapture(e.pointerId);
    root.setAttribute("data-panning", "");
    h.onGestureStart();
  };

  const onPointerMove = (e: PointerEvent) => {
    h.lastPointer.x = e.clientX;
    h.lastPointer.y = e.clientY;
    if (!panning || e.pointerId !== panPointer) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    setCameraValue(panBy(getCamera(), dx, dy));
    h.onGestureMove();
  };

  const endPan = (e: PointerEvent) => {
    if (!panning || e.pointerId !== panPointer) return;
    panning = false;
    root.removeAttribute("data-panning");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === "Space" && !e.repeat) {
      space = true;
      root.setAttribute("data-space", "");
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") {
      space = false;
      root.removeAttribute("data-space");
    }
  };

  const onBlur = () => {
    space = false;
    root.removeAttribute("data-space");
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerup", endPan);
  root.addEventListener("pointercancel", endPan);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  return () => {
    root.removeEventListener("wheel", onWheel);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", endPan);
    root.removeEventListener("pointercancel", endPan);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}

export function zoomStepAt(
  p: Point,
  direction: 1 | -1,
): void {
  const cam = getCamera();
  const z2 = nextZoomStep(cam.z, direction);
  setCameraValue(zoomAt(cam, p, z2));
}

export { zoomAt };
