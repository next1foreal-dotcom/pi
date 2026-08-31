import type { Camera, Rect } from "../core/types";
import { resolveSpotlightTarget, spotlightCamera } from "./geometry";

export const ATTRIBUTION_MS = 1000;
export const COALESCE_MS = 300;
export const HOLD_MS = 1200;

export type SpotlightPhase =
  | "idle"
  | "armed"
  | "collecting"
  | "flying"
  | "holding"
  | "returning"
  | "deferred";

export type SpotlightState = {
  phase: SpotlightPhase;
  savedCamera: Camera | null;
  target: Rect | null;
  pendingTarget: Rect | null;
  overlay: Rect | null;
};

export type SpotlightEvent =
  | { type: "hmr" }
  | { type: "mutation"; rects: readonly Rect[] }
  | { type: "attributionElapsed" }
  | { type: "coalesceElapsed" }
  | { type: "flyArrived" }
  | { type: "holdElapsed" }
  | { type: "returnArrived" }
  | { type: "gesture" }
  | { type: "visible" }
  | { type: "hidden" };

export type SpotlightContext = {
  hidden: boolean;
  reducedMotion: boolean;
  camera: Camera;
  viewport: { width: number; height: number };
  screenFallback: Rect;
};

export type SpotlightEffect =
  | { type: "schedule"; timer: "attribution" | "coalesce" | "hold"; ms: number }
  | { type: "cancelTimers" }
  | { type: "animateTo"; camera: Camera }
  | { type: "animateBack"; camera: Camera }
  | { type: "cancelAnimation" }
  | { type: "hideOverlay"; fast: boolean };

export function createSpotlightState(): SpotlightState {
  return {
    phase: "idle",
    savedCamera: null,
    target: null,
    pendingTarget: null,
    overlay: null,
  };
}

function resetFields(): Pick<
  SpotlightState,
  "savedCamera" | "target" | "pendingTarget" | "overlay"
> {
  return {
    savedCamera: null,
    target: null,
    pendingTarget: null,
    overlay: null,
  };
}

function abortEffects(fastHide: boolean): SpotlightEffect[] {
  return [
    { type: "cancelTimers" },
    { type: "cancelAnimation" },
    { type: "hideOverlay", fast: fastHide },
  ];
}

function arm(hidden: boolean): { state: SpotlightState; effects: SpotlightEffect[] } {
  if (hidden) {
    return {
      state: { phase: "deferred", ...resetFields() },
      effects: abortEffects(true),
    };
  }
  return {
    state: { phase: "armed", ...resetFields() },
    effects: [
      ...abortEffects(true),
      { type: "schedule", timer: "attribution", ms: ATTRIBUTION_MS },
    ],
  };
}

function beginChoreography(
  state: SpotlightState,
  ctx: SpotlightContext,
): { state: SpotlightState; effects: SpotlightEffect[] } {
  const raw = state.target ?? state.pendingTarget;
  const target = resolveSpotlightTarget(raw ? [raw] : [], ctx.screenFallback);
  const savedCamera = { ...ctx.camera };
  if (ctx.reducedMotion) {
    return {
      state: {
        phase: "holding",
        savedCamera,
        target,
        pendingTarget: null,
        overlay: target,
      },
      effects: [{ type: "schedule", timer: "hold", ms: HOLD_MS }],
    };
  }
  return {
    state: {
      phase: "flying",
      savedCamera,
      target,
      pendingTarget: null,
      overlay: null,
    },
    effects: [{ type: "animateTo", camera: spotlightCamera(target, ctx.viewport) }],
  };
}

export function stepSpotlight(
  state: SpotlightState,
  event: SpotlightEvent,
  ctx: SpotlightContext,
): { state: SpotlightState; effects: SpotlightEffect[] } {
  switch (event.type) {
    case "hmr":
      return arm(ctx.hidden);

    case "mutation": {
      if (
        state.phase === "idle" ||
        state.phase === "flying" ||
        state.phase === "holding" ||
        state.phase === "returning"
      ) {
        return { state, effects: [] };
      }
      const merged = resolveSpotlightTarget(
        [
          ...(state.target ? [state.target] : []),
          ...(state.pendingTarget ? [state.pendingTarget] : []),
          ...event.rects,
        ],
        ctx.screenFallback,
      );
      if (state.phase === "deferred") {
        return {
          state: { ...state, target: merged, pendingTarget: merged },
          effects: [],
        };
      }
      return {
        state: { ...state, phase: "collecting", target: merged },
        effects: [
          { type: "cancelTimers" },
          { type: "schedule", timer: "coalesce", ms: COALESCE_MS },
        ],
      };
    }

    case "attributionElapsed":
      if (state.phase !== "armed") return { state, effects: [] };
      return { state: createSpotlightState(), effects: [] };

    case "coalesceElapsed":
      if (state.phase !== "collecting") return { state, effects: [] };
      return beginChoreography(state, ctx);

    case "flyArrived":
      if (state.phase !== "flying") return { state, effects: [] };
      return {
        state: { ...state, phase: "holding", overlay: state.target },
        effects: [{ type: "schedule", timer: "hold", ms: HOLD_MS }],
      };

    case "holdElapsed":
      if (state.phase !== "holding") return { state, effects: [] };
      if (ctx.reducedMotion || !state.savedCamera) {
        return {
          state: createSpotlightState(),
          effects: [{ type: "hideOverlay", fast: false }],
        };
      }
      return {
        state: { ...state, phase: "returning" },
        effects: [{ type: "animateBack", camera: state.savedCamera }],
      };

    case "returnArrived":
      if (state.phase !== "returning") return { state, effects: [] };
      return {
        state: createSpotlightState(),
        effects: [{ type: "hideOverlay", fast: false }],
      };

    case "gesture": {
      if (
        state.phase === "idle" ||
        state.phase === "armed" ||
        state.phase === "collecting" ||
        state.phase === "deferred"
      ) {
        if (state.phase === "idle") return { state, effects: [] };
        return { state: createSpotlightState(), effects: abortEffects(true) };
      }
      return { state: createSpotlightState(), effects: abortEffects(true) };
    }

    case "hidden": {
      if (state.phase === "idle" || state.phase === "deferred") {
        return { state, effects: [] };
      }
      const pending = state.target ?? state.pendingTarget;
      return {
        state: {
          phase: "deferred",
          savedCamera: null,
          target: pending,
          pendingTarget: pending,
          overlay: null,
        },
        effects: abortEffects(true),
      };
    }

    case "visible": {
      if (ctx.hidden || state.phase !== "deferred") {
        return { state, effects: [] };
      }
      if (!state.pendingTarget && !state.target) {
        return { state: createSpotlightState(), effects: [] };
      }
      return beginChoreography(state, ctx);
    }
  }
}
