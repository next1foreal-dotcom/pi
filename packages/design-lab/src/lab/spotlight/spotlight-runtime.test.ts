// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { Camera, Rect } from "../core/types";
import { COALESCE_MS, HOLD_MS } from "./spotlight-machine";
import {
  createSpotlightRuntime,
  type SpotlightRuntimeHost,
} from "./spotlight-runtime";

const VIEWPORT = { width: 1280, height: 720 };
const SCREEN: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const BOX: Rect = { x: 40, y: 40, width: 80, height: 40 };
const CAM: Camera = { x: 0, y: 0, z: 0.4 };

type Scheduled = { id: number; fn: () => void; at: number };

function makeHost(
  overrides: Partial<{ hidden: boolean; reducedMotion: boolean }> = {},
): SpotlightRuntimeHost & {
  now: number;
  hiddenFlag: boolean;
  reduced: boolean;
  camera: Camera;
  timeouts: Scheduled[];
  animateTo: Camera[];
  animateBack: Camera[];
  cancelled: number;
  overlays: { rect: Rect | null; fast: boolean }[];
  nextId: number;
} {
  const host = {
    now: 0,
    hiddenFlag: overrides.hidden ?? false,
    reduced: overrides.reducedMotion ?? false,
    camera: { ...CAM },
    timeouts: [] as Scheduled[],
    animateTo: [] as Camera[],
    animateBack: [] as Camera[],
    cancelled: 0,
    overlays: [] as { rect: Rect | null; fast: boolean }[],
    nextId: 1,
    nowMs: () => host.now,
    isHidden: () => host.hiddenFlag,
    prefersReducedMotion: () => host.reduced,
    getCamera: () => host.camera,
    getViewport: () => VIEWPORT,
    getOrigin: () => ({ x: 0, y: 0 }),
    animateCamera: (
      _from: Camera,
      to: Camera,
      _viewport: { width: number; height: number },
      _onTick?: (cam: Camera) => void,
      onDone?: () => void,
    ) => {
      host.animateTo.push(to);
      onDone?.();
    },
    cancelCameraAnimation: () => {
      host.cancelled += 1;
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = host.nextId++;
      host.timeouts.push({ id, fn, at: host.now + ms });
      return id;
    },
    clearTimeout: (id: number) => {
      host.timeouts = host.timeouts.filter((t) => t.id !== id);
    },
    setOverlay: (rect: Rect | null, fast: boolean) => {
      host.overlays.push({ rect, fast });
    },
  };
  return host;
}

function flush(host: ReturnType<typeof makeHost>, to: number): void {
  host.now = to;
  const due = host.timeouts.filter((t) => t.at <= host.now);
  host.timeouts = host.timeouts.filter((t) => t.at > host.now);
  for (const t of due) t.fn();
}

describe("runtime: two-key trigger", () => {
  it("does not animate on mutation outside the HMR window", () => {
    const host = makeHost();
    const rt = createSpotlightRuntime(host);
    rt.noteMutation([BOX], SCREEN);
    expect(host.animateTo).toEqual([]);
    expect(host.timeouts).toEqual([]);
  });

  it("HMR + mutation coalesces 300ms then flies", () => {
    const host = makeHost();
    const rt = createSpotlightRuntime(host);
    rt.noteHmr();
    rt.noteMutation([BOX], SCREEN);
    expect(host.animateTo).toEqual([]);
    flush(host, COALESCE_MS);
    expect(host.animateTo.length).toBe(1);
  });
});

describe("runtime: hidden pane does not use hidden-period timers", () => {
  it("HMR while hidden stores pending and plays once on visible", () => {
    const host = makeHost({ hidden: true });
    const rt = createSpotlightRuntime(host);
    rt.noteHmr();
    expect(host.timeouts).toEqual([]);
    rt.noteMutation([BOX], SCREEN);
    expect(host.timeouts).toEqual([]);
    expect(host.animateTo).toEqual([]);
    host.hiddenFlag = false;
    rt.noteVisible();
    expect(host.animateTo.length).toBe(1);
    const first = host.animateTo.length;
    rt.noteVisible();
    expect(host.animateTo.length).toBe(first);
  });
});

describe("runtime: gesture yields the camera", () => {
  it("cancels an in-flight spotlight without scheduling a return", () => {
    const host = makeHost();
    const rt = createSpotlightRuntime(host);
    rt.noteHmr();
    rt.noteMutation([BOX], SCREEN);
    flush(host, COALESCE_MS);
    expect(host.animateTo.length).toBe(1);
    host.animateBack = [];
    rt.noteGesture();
    expect(host.cancelled).toBeGreaterThan(0);
    expect(host.animateBack).toEqual([]);
    const overlayHide = host.overlays.filter((o) => o.rect === null);
    expect(overlayHide.some((o) => o.fast)).toBe(true);
  });
});

describe("runtime: hold duration", () => {
  it("reduced-motion path holds 1200ms then hides, never flies", () => {
    const host = makeHost({ reducedMotion: true });
    const rt = createSpotlightRuntime(host);
    rt.noteHmr();
    rt.noteMutation([BOX], SCREEN);
    flush(host, COALESCE_MS);
    expect(host.animateTo).toEqual([]);
    expect(host.overlays.some((o) => o.rect !== null)).toBe(true);
    flush(host, COALESCE_MS + HOLD_MS);
    expect(host.overlays.at(-1)?.rect).toBeNull();
    expect(host.animateTo).toEqual([]);
  });
});
