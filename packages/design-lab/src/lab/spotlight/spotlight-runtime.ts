import type { Camera, Point, Rect } from "../core/types";
import {
  createSpotlightState,
  stepSpotlight,
  type SpotlightEffect,
  type SpotlightEvent,
  type SpotlightState,
} from "./spotlight-machine";

export type SpotlightRuntimeHost = {
  nowMs: () => number;
  isHidden: () => boolean;
  prefersReducedMotion: () => boolean;
  getCamera: () => Camera;
  getViewport: () => { width: number; height: number };
  getOrigin: () => Point;
  animateCamera: (
    from: Camera,
    to: Camera,
    viewport: { width: number; height: number },
    onTick?: (cam: Camera) => void,
    onDone?: () => void,
  ) => void;
  cancelCameraAnimation: () => void;
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setOverlay: (rect: Rect | null, fast: boolean) => void;
};

const DUMMY_FALLBACK: Rect = { x: 0, y: 0, width: 1, height: 1 };

export type SpotlightRuntime = {
  noteHmr: () => void;
  noteMutation: (rects: readonly Rect[], screenFallback: Rect) => void;
  noteGesture: () => void;
  noteVisible: () => void;
  noteHidden: () => void;
  getState: () => SpotlightState;
  dispose: () => void;
};

export function createSpotlightRuntime(
  host: SpotlightRuntimeHost,
): SpotlightRuntime {
  let state = createSpotlightState();
  let lastFallback = DUMMY_FALLBACK;
  const timerIds: Partial<Record<"attribution" | "coalesce" | "hold", number>> =
    {};
  let disposed = false;

  function context(fallback: Rect) {
    return {
      hidden: host.isHidden(),
      reducedMotion: host.prefersReducedMotion(),
      camera: host.getCamera(),
      viewport: host.getViewport(),
      screenFallback: fallback,
    };
  }

  function runEffects(effects: SpotlightEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "cancelTimers") {
        for (const key of Object.keys(timerIds) as (keyof typeof timerIds)[]) {
          const id = timerIds[key];
          if (id !== undefined) host.clearTimeout(id);
          delete timerIds[key];
        }
      } else if (effect.type === "schedule") {
        if (host.isHidden()) continue;
        const prev = timerIds[effect.timer];
        if (prev !== undefined) host.clearTimeout(prev);
        timerIds[effect.timer] = host.setTimeout(() => {
          delete timerIds[effect.timer];
          if (effect.timer === "attribution") apply({ type: "attributionElapsed" });
          else if (effect.timer === "coalesce") apply({ type: "coalesceElapsed" });
          else apply({ type: "holdElapsed" });
        }, effect.ms);
      } else if (effect.type === "animateTo") {
        host.animateCamera(
          host.getCamera(),
          effect.camera,
          host.getViewport(),
          undefined,
          () => apply({ type: "flyArrived" }),
        );
      } else if (effect.type === "animateBack") {
        host.animateCamera(
          host.getCamera(),
          effect.camera,
          host.getViewport(),
          undefined,
          () => apply({ type: "returnArrived" }),
        );
      } else if (effect.type === "cancelAnimation") {
        host.cancelCameraAnimation();
      } else if (effect.type === "hideOverlay") {
        host.setOverlay(null, effect.fast);
      }
    }
    if (state.overlay) host.setOverlay(state.overlay, false);
  }

  function apply(event: SpotlightEvent, fallback: Rect = lastFallback): void {
    if (disposed) return;
    lastFallback = fallback;
    const next = stepSpotlight(state, event, context(fallback));
    state = next.state;
    runEffects(next.effects);
  }

  return {
    noteHmr: () => apply({ type: "hmr" }),
    noteMutation: (rects, screenFallback) =>
      apply({ type: "mutation", rects }, screenFallback),
    noteGesture: () => apply({ type: "gesture" }),
    noteVisible: () => apply({ type: "visible" }),
    noteHidden: () => apply({ type: "hidden" }),
    getState: () => state,
    dispose: () => {
      disposed = true;
      for (const key of Object.keys(timerIds) as (keyof typeof timerIds)[]) {
        const id = timerIds[key];
        if (id !== undefined) host.clearTimeout(id);
        delete timerIds[key];
      }
      host.cancelCameraAnimation();
      host.setOverlay(null, true);
    },
  };
}
