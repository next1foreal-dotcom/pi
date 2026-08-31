import { describe, expect, it } from "vitest";
import type { Camera, Rect } from "../core/types";
import {
  ATTRIBUTION_MS,
  COALESCE_MS,
  HOLD_MS,
  createSpotlightState,
  stepSpotlight,
  type SpotlightContext,
  type SpotlightEffect,
  type SpotlightEvent,
  type SpotlightState,
} from "./spotlight-machine";

const VIEWPORT = { width: 1280, height: 720 };
const SCREEN: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const BOX: Rect = { x: 100, y: 80, width: 40, height: 20 };
const CAM: Camera = { x: 12, y: 8, z: 0.35 };

const VISIBLE: SpotlightContext = {
  hidden: false,
  reducedMotion: false,
  camera: CAM,
  viewport: VIEWPORT,
  screenFallback: SCREEN,
};

function run(
  events: SpotlightEvent[],
  ctx: SpotlightContext = VISIBLE,
  start: SpotlightState = createSpotlightState(),
): { state: SpotlightState; effects: SpotlightEffect[] } {
  let state = start;
  let effects: SpotlightEffect[] = [];
  for (const event of events) {
    const next = stepSpotlight(state, event, ctx);
    state = next.state;
    effects = next.effects;
  }
  return { state, effects };
}

function typesOf(effects: SpotlightEffect[]): SpotlightEffect["type"][] {
  return effects.map((e) => e.type);
}

describe("timing constants (pinned)", () => {
  it("attribution window is 1000ms", () => {
    expect(ATTRIBUTION_MS).toBe(1000);
  });
  it("coalesce is 300ms", () => {
    expect(COALESCE_MS).toBe(300);
  });
  it("hold is 1200ms", () => {
    expect(HOLD_MS).toBe(1200);
  });
});

describe("happy path idle → armed → collecting → flying → holding → returning → idle", () => {
  it("HMR arms a 1000ms attribution window", () => {
    const { state, effects } = run([{ type: "hmr" }]);
    expect(state.phase).toBe("armed");
    expect(effects).toContainEqual({
      type: "schedule",
      timer: "attribution",
      ms: 1000,
    });
  });

  it("mutation inside the window starts a 300ms coalesce", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
    ]);
    expect(state.phase).toBe("collecting");
    expect(effects).toContainEqual({
      type: "schedule",
      timer: "coalesce",
      ms: 300,
    });
    expect(typesOf(effects)).toContain("cancelTimers");
  });

  it("coalesce elapsed flies to the union bbox and remembers the camera", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
      { type: "coalesceElapsed" },
    ]);
    expect(state.phase).toBe("flying");
    expect(state.savedCamera).toEqual(CAM);
    expect(typesOf(effects)).toContain("animateTo");
  });

  it("fly arrival holds 1200ms with overlay visible", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
      { type: "coalesceElapsed" },
      { type: "flyArrived" },
    ]);
    expect(state.phase).toBe("holding");
    expect(effects).toContainEqual({
      type: "schedule",
      timer: "hold",
      ms: 1200,
    });
    expect(state.overlay).not.toBeNull();
  });

  it("hold elapsed flies back to the saved camera", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
      { type: "coalesceElapsed" },
      { type: "flyArrived" },
      { type: "holdElapsed" },
    ]);
    expect(state.phase).toBe("returning");
    expect(effects).toContainEqual({ type: "animateBack", camera: CAM });
  });

  it("return arrival clears overlay and returns to idle", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
      { type: "coalesceElapsed" },
      { type: "flyArrived" },
      { type: "holdElapsed" },
      { type: "returnArrived" },
    ]);
    expect(state.phase).toBe("idle");
    expect(state.overlay).toBeNull();
    expect(state.savedCamera).toBeNull();
    expect(typesOf(effects)).toContain("hideOverlay");
  });
});

describe("attribution window sides", () => {
  it("mutation with no HMR window does not trigger spotlight", () => {
    const { state, effects } = run([{ type: "mutation", rects: [BOX] }]);
    expect(state.phase).toBe("idle");
    expect(typesOf(effects)).not.toContain("schedule");
    expect(typesOf(effects)).not.toContain("animateTo");
  });

  it("armed window expiring with no mutations returns to idle", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "attributionElapsed" },
    ]);
    expect(state.phase).toBe("idle");
    expect(typesOf(effects)).not.toContain("animateTo");
  });

  it("mutation after the window has closed does not trigger", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "attributionElapsed" },
      { type: "mutation", rects: [BOX] },
    ]);
    expect(state.phase).toBe("idle");
    expect(typesOf(effects)).not.toContain("animateTo");
    expect(typesOf(effects)).not.toContain("schedule");
  });
});

describe("human camera gesture cancels without flying back", () => {
  const choreography: SpotlightEvent[] = [
    { type: "hmr" },
    { type: "mutation", rects: [BOX] },
    { type: "coalesceElapsed" },
  ];

  for (const phaseEvent of [
    { name: "flying", extra: [] as SpotlightEvent[] },
    { name: "holding", extra: [{ type: "flyArrived" } as SpotlightEvent] },
    {
      name: "returning",
      extra: [
        { type: "flyArrived" } as SpotlightEvent,
        { type: "holdElapsed" } as SpotlightEvent,
      ],
    },
  ]) {
    it(`gesture in ${phaseEvent.name} cancels, no fly-back`, () => {
      const { state, effects } = run([
        ...choreography,
        ...phaseEvent.extra,
        { type: "gesture" },
      ]);
      expect(state.phase).toBe("idle");
      expect(state.savedCamera).toBeNull();
      expect(typesOf(effects)).toContain("cancelAnimation");
      expect(typesOf(effects)).not.toContain("animateBack");
      expect(effects).toContainEqual({ type: "hideOverlay", fast: true });
    });
  }
});

describe("latest HMR wins", () => {
  it("HMR during an in-flight spotlight restarts from armed", () => {
    const { state, effects } = run([
      { type: "hmr" },
      { type: "mutation", rects: [BOX] },
      { type: "coalesceElapsed" },
      { type: "hmr" },
    ]);
    expect(state.phase).toBe("armed");
    expect(state.savedCamera).toBeNull();
    expect(typesOf(effects)).toContain("cancelAnimation");
    expect(typesOf(effects)).not.toContain("animateBack");
    expect(effects).toContainEqual({
      type: "schedule",
      timer: "attribution",
      ms: 1000,
    });
  });
});

describe("hidden pane defers; visible plays exactly once", () => {
  it("HMR while hidden goes deferred and schedules no timers", () => {
    const { state, effects } = run([{ type: "hmr" }], {
      ...VISIBLE,
      hidden: true,
    });
    expect(state.phase).toBe("deferred");
    expect(typesOf(effects)).not.toContain("schedule");
    expect(typesOf(effects)).not.toContain("animateTo");
  });

  it("mutations while deferred update pending without timers", () => {
    const { state, effects } = run(
      [
        { type: "hmr" },
        { type: "mutation", rects: [BOX] },
      ],
      { ...VISIBLE, hidden: true },
    );
    expect(state.phase).toBe("deferred");
    expect(state.pendingTarget).not.toBeNull();
    expect(typesOf(effects)).not.toContain("schedule");
  });

  it("becoming visible with a pending target plays choreography once", () => {
    const start = run(
      [
        { type: "hmr" },
        { type: "mutation", rects: [BOX] },
      ],
      { ...VISIBLE, hidden: true },
    ).state;
    const { state, effects } = run([{ type: "visible" }], VISIBLE, start);
    expect(state.phase).toBe("flying");
    expect(typesOf(effects)).toContain("animateTo");
    const again = run([{ type: "visible" }], VISIBLE, state);
    expect(again.state.phase).toBe("flying");
    expect(typesOf(again.effects)).not.toContain("animateTo");
  });
});

describe("prefers-reduced-motion", () => {
  it("skips flight and only shows the overlay", () => {
    const ctx = { ...VISIBLE, reducedMotion: true };
    const { state, effects } = run(
      [
        { type: "hmr" },
        { type: "mutation", rects: [BOX] },
        { type: "coalesceElapsed" },
      ],
      ctx,
    );
    expect(state.phase).toBe("holding");
    expect(typesOf(effects)).not.toContain("animateTo");
    expect(typesOf(effects)).not.toContain("animateBack");
    expect(state.overlay).not.toBeNull();
    expect(effects).toContainEqual({
      type: "schedule",
      timer: "hold",
      ms: 1200,
    });
  });
});
