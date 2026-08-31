import {
  getCamera,
  seedCamera,
  setCameraExact,
} from "./camera";
import {
  boundsOf,
  cameraTransform,
  expandRect,
  rectsIntersect,
  snapTranslateToDevicePixels,
  viewportPageBounds,
  zoomToBounds,
} from "./math";
import {
  dropUnknownIds,
  loadPersisted,
  overlayLayout,
  saveNow,
  scheduleSave,
} from "./persistence";
import { pushToast } from "./lab-toasts";
import { paintPixelGrid } from "./pixel-grid";
import { animateCamera } from "./animate-camera";
import { measureSegments, paintMeasurements } from "./measurements";
import { pushHistory, setNotice, type HistoryCommand } from "./history";
import { labFs } from "./fs-client";
import type { ResizeEdge } from "./screen-frame";
import { SCREENS, screenById } from "../screens";
import type { Camera, Mode, PersistedV1, Point, ScreenLayout } from "./types";

export const SHOW_PIXEL_GRID = true;
export const SNAP_TO_GRID = true;
export const PIXEL_GRID_STEP = 10;
export const PIXEL_GRID_ALPHA = 0.18;
export const SNAP_TOLERANCE_PX = 8;
export const NUDGE_SMALL = 1;
export const NUDGE_BIG = 10;
export const NUDGE_COMMIT_MS = 400;
export const CLEANUP_GAP = 80;
export const IDLE_MS = 160;
export const MIN_FRAME_W = 320;
export const MIN_FRAME_H = 240;

export const persistedBoot = loadPersisted();

function initialLayouts(): Record<string, ScreenLayout> {
  const known = new Set(SCREENS.map((s) => s.id));
  const overrides = persistedBoot
    ? dropUnknownIds(persistedBoot.screens, known)
    : {};
  const layouts: Record<string, ScreenLayout> = {};
  for (const s of SCREENS) {
    layouts[s.id] = overlayLayout(
      s.id,
      {
        x: s.defaultPosition.x,
        y: s.defaultPosition.y,
        width: s.width,
        height: s.height,
      },
      overrides,
    );
  }
  return layouts;
}

export const bootLayouts = initialLayouts();

function initialCamera(): Camera {
  if (persistedBoot?.camera) return persistedBoot.camera;
  const b = boundsOf(Object.values(bootLayouts));
  if (!b) return { x: 0, y: 0, z: 1 };
  return zoomToBounds(b, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

seedCamera(initialCamera());

type Drag =
  | {
      kind: "move" | "ghost";
      id: string;
      start: ScreenLayout;
      current: ScreenLayout;
      px: number;
      py: number;
    }
  | {
      kind: "resize";
      id: string;
      edge: ResizeEdge;
      start: ScreenLayout;
      current: ScreenLayout;
      px: number;
      py: number;
    };

export type Session = {
  root: HTMLDivElement | null;
  layer: HTMLDivElement | null;
  grid: HTMLCanvasElement | null;
  measure: HTMLCanvasElement | null;
  snapX: HTMLDivElement | null;
  snapY: HTMLDivElement | null;
  ghost: HTMLDivElement | null;
  chrome: Map<string, HTMLElement>;
  origin: Point;
  viewport: { width: number; height: number };
  gesturing: boolean;
  idleTimer: number;
  lastMove: number;
  willChangeOn: boolean;
  dropWillChange: number;
  canvasColor: string;
  savedColors: string[];
  mode: Mode;
  selectedId: string | null;
  focusedId: string | null;
  exploreCamera: Camera | null;
  layouts: Record<string, ScreenLayout>;
  names: Record<string, string>;
  visible: Record<string, boolean>;
  lastPointer: Point;
  drag: Drag | null;
  alt: boolean;
  measureHover: string | null;
  nudge: { id: string; from: { x: number; y: number }; timer: number } | null;
  escapers: Map<string, () => boolean>;
  bump: () => void;
  getGuides: () => { axis: "x" | "y"; pos: number }[];
  rulerKey: (e: KeyboardEvent) => boolean;
  notesKey: (e: KeyboardEvent) => boolean;
  labelsKey: (e: KeyboardEvent) => boolean;
  rulerRefresh: () => void;
  disposeExtras: () => void;
  getSnapshot: () => PersistedV1;
};

export function snapshotOf(s: Session): PersistedV1 {
  const screens: PersistedV1["screens"] = {};
  for (const id of Object.keys(s.layouts)) {
    const l = s.layouts[id];
    screens[id] = { x: l.x, y: l.y, width: l.width, height: l.height };
  }
  return {
    camera: getCamera(),
    screens,
    canvasColor: s.canvasColor,
    savedColors: s.savedColors,
  };
}

function liveLayout(s: Session, id: string): ScreenLayout {
  if (s.drag && s.drag.id === id && s.drag.kind !== "ghost") return s.drag.current;
  const l = s.layouts[id];
  if (s.mode === "fill" && s.focusedId === id) {
    return { ...l, width: s.viewport.width, height: s.viewport.height };
  }
  return l;
}

function writeFrame(s: Session, id: string, layout: ScreenLayout): void {
  const el = s.layer?.querySelector(`[data-screen-id="${id}"]`);
  if (!(el instanceof HTMLElement)) return;
  el.style.transform = `translate(${layout.x}px, ${layout.y}px)`;
  el.style.width = `${layout.width}px`;
  el.style.height = `${layout.height}px`;
}

function placeChrome(s: Session): void {
  const cam = getCamera();
  for (const [id, el] of s.chrome) {
    const l = liveLayout(s, id);
    const x = (l.x + cam.x) * cam.z;
    const y = (l.y + cam.y) * cam.z;
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.width = `${l.width * cam.z}px`;
  }
  s.rulerRefresh();
}

function showSnap(s: Session, lines: { axis: "x" | "y"; pos: number }[]): void {
  const cam = getCamera();
  if (s.snapX) {
    const line = lines.find((l) => l.axis === "x");
    s.snapX.style.display = line ? "block" : "none";
    if (line) s.snapX.style.left = `${(line.pos + cam.x) * cam.z}px`;
  }
  if (s.snapY) {
    const line = lines.find((l) => l.axis === "y");
    s.snapY.style.display = line ? "block" : "none";
    if (line) s.snapY.style.top = `${(line.pos + cam.y) * cam.z}px`;
  }
}

function hideSnap(s: Session): void {
  if (s.snapX) s.snapX.style.display = "none";
  if (s.snapY) s.snapY.style.display = "none";
}

function applyCull(s: Session): void {
  if (s.viewport.width < 2 || s.viewport.height < 2) return;
  const cam = getCamera();
  const view = expandRect(
    viewportPageBounds(cam, s.viewport),
    (s.viewport.width / cam.z) * 0.25,
  );
  let changed = false;
  for (const scr of SCREENS) {
    const l = liveLayout(s, scr.id);
    const keep =
      scr.id === s.selectedId ||
      scr.id === s.focusedId ||
      rectsIntersect(l, view);
    if (s.visible[scr.id] !== keep) {
      s.visible[scr.id] = keep;
      changed = true;
    }
    const el = s.layer?.querySelector(`[data-screen-id="${scr.id}"]`);
    if (el instanceof HTMLElement) el.toggleAttribute("data-culled", !keep);
  }
  if (changed) s.bump();
}

export function paintMeasure(s: Session): void {
  if (!s.measure) return;
  const sel = s.selectedId ? liveLayout(s, s.selectedId) : null;
  const hover =
    s.alt && s.measureHover && s.measureHover !== s.selectedId
      ? liveLayout(s, s.measureHover)
      : null;
  const segs = sel && hover ? measureSegments(hover, sel) : [];
  paintMeasurements(s.measure, segs, sel, getCamera(), s.viewport);
}

function applyCamera(s: Session, camera: Camera): void {
  const layer = s.layer;
  if (!layer) return;
  layer.style.transform = cameraTransform(camera);
  layer.style.setProperty("--inv-zoom", String(1 / camera.z));
  if (SHOW_PIXEL_GRID && s.grid && s.mode !== "fill") {
    paintPixelGrid(s.grid, camera, s.viewport, {
      step: PIXEL_GRID_STEP,
      alpha: PIXEL_GRID_ALPHA,
      canvasHex: s.canvasColor,
    });
  }
  placeChrome(s);
  applyCull(s);
  paintMeasure(s);
}

function markGesture(s: Session): void {
  s.gesturing = true;
  s.lastMove = performance.now();
  if (s.dropWillChange) {
    cancelAnimationFrame(s.dropWillChange);
    s.dropWillChange = 0;
  }
  if (s.layer && !s.willChangeOn) {
    s.layer.style.willChange = "transform";
    s.willChangeOn = true;
  }
  if (s.root && s.mode === "explore") s.root.dataset.gesturing = "";
  if (!s.idleTimer) {
    const tick = () => {
      const wait = IDLE_MS - (performance.now() - s.lastMove);
      if (wait > 0) {
        s.idleTimer = window.setTimeout(tick, wait);
        return;
      }
      s.idleTimer = 0;
      s.gesturing = false;
      s.root?.removeAttribute("data-gesturing");
      setCameraExact(
        snapTranslateToDevicePixels(getCamera(), window.devicePixelRatio || 1),
        "idle",
      );
      scheduleSave(s.getSnapshot());
      s.dropWillChange = requestAnimationFrame(() => {
        s.dropWillChange = 0;
        if (s.gesturing) return;
        if (s.layer) s.layer.style.willChange = "auto";
        s.willChangeOn = false;
      });
    };
    s.idleTimer = window.setTimeout(tick, IDLE_MS);
  }
}

function persist(s: Session): void {
  scheduleSave(s.getSnapshot());
}

function commitNudge(s: Session): void {
  if (!s.nudge) return;
  window.clearTimeout(s.nudge.timer);
  const { id, from } = s.nudge;
  s.nudge = null;
  const to = s.layouts[id];
  if (to && (to.x !== from.x || to.y !== from.y)) {
    pushHistory({ type: "move", id, from, to: { x: to.x, y: to.y } });
  }
  persist(s);
}

function fitAll(s: Session): void {
  const b = boundsOf(Object.values(s.layouts));
  if (!b) return;
  animateCamera(getCamera(), zoomToBounds(b, s.viewport), s.viewport);
}

function lockInto(s: Session, id: string, fill = false): void {
  if (s.mode === "explore") s.exploreCamera = { ...getCamera() };
  s.focusedId = id;
  s.selectedId = id;
  s.mode = fill ? "fill" : "focus";
  s.root?.setAttribute("data-mode", s.mode);
  s.bump();
  if (fill) {
    const l = s.layouts[id];
    setCameraExact({ x: -l.x, y: -l.y, z: 1 });
  } else {
    animateCamera(
      getCamera(),
      zoomToBounds(s.layouts[id], s.viewport),
      s.viewport,
    );
  }
  requestAnimationFrame(() => {
    const node = s.root?.querySelector(`[data-screen-scroll="${id}"]`);
    if (node instanceof HTMLElement) node.focus();
  });
}

function exitOne(s: Session): void {
  if (s.mode === "fill") {
    s.mode = "focus";
    s.root?.setAttribute("data-mode", "focus");
    s.bump();
    if (s.focusedId) {
      animateCamera(
        getCamera(),
        zoomToBounds(s.layouts[s.focusedId], s.viewport),
        s.viewport,
      );
    }
    return;
  }
  if (s.mode === "focus") {
    s.mode = "explore";
    s.focusedId = null;
    s.root?.setAttribute("data-mode", "explore");
    s.bump();
    animateCamera(getCamera(), s.exploreCamera ?? getCamera(), s.viewport);
  }
}

function cycle(s: Session, dir: 1 | -1): void {
  if (SCREENS.length === 0) return;
  const ids = SCREENS.map((x) => x.id);
  const cur = s.focusedId ?? s.selectedId ?? ids[0];
  const i = Math.max(0, ids.indexOf(cur));
  const next = ids[(i + dir + ids.length) % ids.length];
  if (s.mode === "fill") {
    s.focusedId = next;
    s.selectedId = next;
    s.bump();
    const l = s.layouts[next];
    setCameraExact({ x: -l.x, y: -l.y, z: 1 });
    return;
  }
  if (s.mode === "focus") {
    lockInto(s, next, false);
    return;
  }
  s.selectedId = next;
  s.bump();
}

async function duplicateScreen(
  s: Session,
  dir: string,
  pos?: { x: number; y: number },
): Promise<void> {
  commitNudge(s);
  saveNow(s.getSnapshot());
  const r = await labFs.duplicate(dir);
  if (!r.ok || !r.dir) {
    pushToast(
      r.error === "dev-server-only"
        ? "Duplicate needs the dev server"
        : "Duplicate failed",
    );
    return;
  }
  if (pos) await labFs.setPositions({ [r.dir]: pos });
  setNotice("Duplicated");
  location.reload();
}

async function deleteScreen(s: Session, id: string): Promise<void> {
  const def = screenById(id);
  if (!def) return;
  commitNudge(s);
  saveNow(s.getSnapshot());
  const r = await labFs.delete(def.dir);
  if (!r.ok || !r.token) {
    pushToast(
      r.error === "dev-server-only" ? "Delete needs the dev server" : "Delete failed",
    );
    return;
  }
  pushHistory({
    type: "delete",
    id,
    dir: def.dir,
    token: r.token,
    layout: s.layouts[id],
  });
  setNotice("Deleted");
  location.reload();
}

async function applyHistory(
  s: Session,
  cmd: HistoryCommand | null,
  invert: boolean,
): Promise<void> {
  if (!cmd) return;
  if (cmd.type === "move") {
    const pos = invert ? cmd.from : cmd.to;
    s.layouts[cmd.id] = { ...s.layouts[cmd.id], ...pos };
    s.selectedId = cmd.id;
    writeFrame(s, cmd.id, s.layouts[cmd.id]);
    s.bump();
    persist(s);
    return;
  }
  if (cmd.type === "resize") {
    s.layouts[cmd.id] = invert ? cmd.from : cmd.to;
    s.selectedId = cmd.id;
    writeFrame(s, cmd.id, s.layouts[cmd.id]);
    s.bump();
    persist(s);
    return;
  }
  if (cmd.type === "reset") {
    s.layouts = invert ? cmd.before : cmd.after;
    s.bump();
    persist(s);
    fitAll(s);
    return;
  }
  if (cmd.type === "canvas") {
    s.canvasColor = invert ? cmd.from : cmd.to;
    s.bump();
    persist(s);
    applyCamera(s, getCamera());
    return;
  }
  if (cmd.type === "rename") {
    const name = invert ? cmd.from : cmd.to;
    s.names[cmd.id] = name;
    s.bump();
    const r = await labFs.rename(cmd.dir, name);
    if (!r.ok) pushToast("skipped — changed on disk");
    return;
  }
  if (cmd.type === "delete") {
    saveNow(s.getSnapshot());
    const r = invert
      ? await labFs.restore(cmd.token)
      : await labFs.delete(cmd.dir);
    if (!r.ok) {
      pushToast("skipped — changed on disk");
      return;
    }
    setNotice(invert ? "Restored" : "Deleted");
    location.reload();
    return;
  }
  if (cmd.type === "duplicate") {
    saveNow(s.getSnapshot());
    const r = invert
      ? await labFs.delete(cmd.copyDir)
      : await labFs.restore(cmd.copyDir);
    if (!r.ok) {
      pushToast("skipped — changed on disk");
      return;
    }
    location.reload();
  }
}

export {
  applyCamera,
  applyHistory,
  commitNudge,
  cycle,
  deleteScreen,
  duplicateScreen,
  exitOne,
  fitAll,
  hideSnap,
  liveLayout,
  lockInto,
  markGesture,
  persist,
  placeChrome,
  showSnap,
  writeFrame,
};

