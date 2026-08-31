import type { Camera } from "./types";
import {
  cameraCentering,
  clamp,
  easeOutQuint,
  pageAtViewportCenter,
  prefersReducedMotion,
} from "./math";
import { setCameraExact } from "./camera";

export type Viewport = { width: number; height: number };

let anim = 0;

export function cancelCameraAnimation(): void {
  if (anim) cancelAnimationFrame(anim);
  anim = 0;
}

export function animateCamera(
  from: Camera,
  to: Camera,
  viewport: Viewport,
  onTick?: (cam: Camera) => void,
  onDone?: () => void,
): void {
  cancelCameraAnimation();
  if (prefersReducedMotion()) {
    setCameraExact(to, "program");
    onTick?.(to);
    onDone?.();
    return;
  }
  const t0 = performance.now();
  const dur = 320;
  const fromZ = Math.log(from.z);
  const toZ = Math.log(to.z);
  const fromC = pageAtViewportCenter(from, viewport);
  const toC = pageAtViewportCenter(to, viewport);

  const frame = (now: number) => {
    const t = clamp((now - t0) / dur, 0, 1);
    const e = easeOutQuint(t);
    const z = Math.exp(fromZ + (toZ - fromZ) * e);
    const cx = fromC.x + (toC.x - fromC.x) * e;
    const cy = fromC.y + (toC.y - fromC.y) * e;
    const cam = cameraCentering({ x: cx, y: cy }, z, viewport);
    setCameraExact(cam, "program");
    onTick?.(cam);
    if (t < 1) {
      anim = requestAnimationFrame(frame);
    } else {
      anim = 0;
      onDone?.();
    }
  };
  anim = requestAnimationFrame(frame);
}

export function isCameraAnimating(): boolean {
  return anim !== 0;
}
