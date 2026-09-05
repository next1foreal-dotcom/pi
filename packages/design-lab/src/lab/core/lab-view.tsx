import {
  Fragment,
  memo,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  attachCameraApplier,
  flushCoarse,
  getCamera,
  getCoarseZoom,
  seedCamera,
  setCameraExact,
  subscribeCoarse,
} from "./camera";
import {
  boundsOf,
  isTypingTarget,
  luminance,
  normalizeHex,
  screenToPage,
  zoomAt,
  zoomToBounds,
} from "./math";
import { consumeFirstVisit, DEFAULT_CANVAS, saveNow } from "./persistence";
import { pushToast, useToasts } from "./lab-toasts";
import { animateCamera, cancelCameraAnimation } from "./animate-camera";
import { bindCanvasInput, zoomStepAt } from "./canvas-input";
import { snapMovingBox, snapResize } from "./snapping";
import { pushHistory, popRedo, popUndo, takeNotice, type LayoutMap } from "./history";
import { labFs } from "./fs-client";
import { applyResize, cleanupRow } from "./frame-ops";
import { ScreenFrame, type ResizeEdge } from "./screen-frame";
import { SCREENS, screenById, type ScreenDef } from "../screens";
import type { Mode } from "./types";
import {
  LAB_PLUGINS,
  type LabPluginHandle,
  type PluginApiDoc,
  publishPluginApis,
} from "../plugin-api";
import { dispatchLabKey } from "./keyboard-dispatch";
import {
  attachLabSpotlight,
  notifySpotlightGesture,
} from "../spotlight/attach";
import { SpotlightOverlay } from "../spotlight/overlay";
import styles from "./lab.module.css";
import {
  CLEANUP_GAP,
  MIN_FRAME_H,
  MIN_FRAME_W,
  NUDGE_COMMIT_MS,
  SNAP_TO_GRID,
  DRAG_THRESHOLD_PX,
  SNAP_TOLERANCE_PX,
  applyCamera,
  applyHistory,
  bootLayouts,
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
  persistedBoot,
  placeChrome,
  paintMeasure,
  showSnap,
  snapshotOf,
  frameTick,
  subscribeFrame,
  writeFrame,
  type Session,
} from "./interaction-lab";

/** Diagnostic: set to true when the keyboard listener is registered inside
 *  attachRoot.  Allows integration tests to verify the listener is wired.
 *  Resets on cleanup (StrictMode or unmount). */
export let __keyboardListenerActive = false;

export function InteractionLab() {
  const zoom = useSyncExternalStore(subscribeCoarse, getCoarseZoom, getCoarseZoom);
  const toasts = useToasts();
  const [, setRev] = useState(0);
  const bump = () => setRev((n) => n + 1);
  const [canvasColor, setCanvasColor] = useState(
    persistedBoot?.canvasColor ?? DEFAULT_CANVAS,
  );
  const [savedColors, setSavedColors] = useState<string[]>(
    persistedBoot?.savedColors ?? [],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [hexDraft, setHexDraft] = useState(canvasColor);
  const [renaming, setRenaming] = useState<string | null>(null);

  const [session] = useState<Session>(() => {
    const s = {
      root: null,
      layer: null,
      grid: null,
      measure: null,
      snapX: null,
      snapY: null,
      ghost: null,
      chrome: new Map(),
      origin: { x: 0, y: 0 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gesturing: false,
      idleTimer: 0,
      lastMove: 0,
      willChangeOn: false,
      dropWillChange: 0,
      canvasColor: persistedBoot?.canvasColor ?? DEFAULT_CANVAS,
      savedColors: persistedBoot?.savedColors ?? [],
      mode: "explore" as Mode,
      selectedId: null,
      focusedId: null,
      exploreCamera: null,
      layouts: { ...bootLayouts },
      names: Object.fromEntries(SCREENS.map((x) => [x.id, x.name])),
      visible: Object.fromEntries(SCREENS.map((x) => [x.id, true])),
      lastPointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
      drag: null,
      alt: false,
      measureHover: null,
      nudge: null,
      escapers: new Map(),
      bump: () => {},
      getGuides: () => [] as { axis: "x" | "y"; pos: number }[],
      plugins: [],
      pluginApis: new Map(),
      pluginsOnCameraWrite: () => {},
      disposeExtras: () => {},
      getSnapshot: () => snapshotOf(s as Session),
    } as Session;
    return s;
  });

  session.bump = bump;
  session.canvasColor = canvasColor;
  session.savedColors = savedColors;

  const theme = luminance(canvasColor) < 0.5 ? "dark" : "light";
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;

  /**
   * A tool button IS its shortcut — it fires the same key the sheet documents,
   * so the two can never drift apart or place a note somewhere else.
   */
  const pressShortcut = (
    code: string,
    key: string,
    mods: KeyboardEventInit = {},
  ) =>
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code,
        key,
        bubbles: true,
        cancelable: true,
        ...mods,
      }),
    );
  const rulerOn = (
    session.pluginApis.get("ruler") as ToolToggle | undefined
  )?.isEnabled();

  const modeBadge =
    session.mode === "explore"
      ? null
      : `${session.names[session.focusedId ?? ""] ?? ""} · Esc to exit`;

  const attachLayer = (el: HTMLDivElement | null) => {
    if (!el) return;
    session.layer = el;
    applyCamera(session, getCamera());
    return () => {
      if (session.layer === el) session.layer = null;
    };
  };

  const attachGrid = (el: HTMLCanvasElement | null) => {
    if (!el) return;
    session.grid = el;
    applyCamera(session, getCamera());
    return () => {
      if (session.grid === el) session.grid = null;
    };
  };

  const attachRoot = (el: HTMLDivElement | null) => {
    if (!el) return;
    session.root = el;
    const box = el.getBoundingClientRect();
    if (box.width >= 2) {
      session.origin = { x: box.left, y: box.top };
      session.viewport = { width: box.width, height: box.height };
      // Re-seed camera from measured viewport when no persisted camera.
      // The module-level seedCamera(initialCamera()) uses window.innerWidth/Height
      // which can be 0 or stale (pre-layout, strict-mode re-mount, iframe).
      // With a valid measured viewport the fit is always correct.
      if (!persistedBoot?.camera) {
        const b = boundsOf(Object.values(session.layouts));
        if (b) seedCamera(zoomToBounds(b, session.viewport));
      }
    }
    attachCameraApplier((cam, reason) => {
      applyCamera(session, cam);
      if (reason === "gesture") notifySpotlightGesture();
    });
    applyCamera(session, getCamera());
    flushCoarse();

    // ── Plugins: the lab is a host, design-time tools are plugins ──────
    const pluginLayer = el.querySelector("[data-plugin-layer]");
    const ctxFor = (host: HTMLElement) => ({
      host,
      getCamera,
      getOrigin: () => session.origin,
      getViewport: () => session.viewport,
      getAppearance: (): "light" | "dark" =>
        luminance(session.canvasColor) < 0.5 ? "dark" : "light",
      getZoom: () => getCamera().z,
      viewportCenterPage: () => {
        const vp = session.viewport;
        const origin = session.origin;
        return screenToPage(
          { x: origin.x + vp.width / 2, y: origin.y + vp.height / 2 },
          getCamera(),
          origin,
        );
      },
    });
    const owned: HTMLElement[] = [];
    const mounted: {
      id: string;
      handle: LabPluginHandle;
      docs?: PluginApiDoc[];
    }[] = [];
    for (const def of LAB_PLUGINS) {
      let host: HTMLElement | null = null;
      if (def.hostSelector) {
        const found = el.querySelector(def.hostSelector);
        host = found instanceof HTMLElement ? found : null;
      } else if (pluginLayer instanceof HTMLElement) {
        // No bespoke host in the JSX: the lab makes one. This is the path a
        // new plugin takes, with no edit to the lab itself.
        host = document.createElement("div");
        host.dataset.plugin = def.id;
        pluginLayer.appendChild(host);
        owned.push(host);
      }
      if (!host) continue;
      const handle = def.mount(ctxFor(host));
      if (handle) {
        session.plugins.push(handle);
        mounted.push({ id: def.id, handle, docs: def.describe });
      }
    }
    session.pluginApis.clear();
    for (const m of mounted) {
      if (m.handle.api !== undefined) session.pluginApis.set(m.id, m.handle.api);
    }
    const unpublish = publishPluginApis(mounted);
    session.pluginsOnCameraWrite = () => {
      for (const p of session.plugins) p.onCameraWrite?.();
    };
    session.getGuides = () => {
      for (const p of session.plugins) {
        const g = p.getGuides?.();
        if (g) return g;
      }
      return [];
    };
    session.disposeExtras = () => {
      unpublish();
      for (const p of session.plugins) p.destroy();
      session.plugins.length = 0;
      for (const host of owned) host.remove();
    };

    const ro = new ResizeObserver(() => {
      const next = el.getBoundingClientRect();
      if (next.width < 2) return;
      session.origin = { x: next.left, y: next.top };
      session.viewport = { width: next.width, height: next.height };
      if (session.mode === "fill" && session.focusedId) {
        writeFrame(session, session.focusedId, liveLayout(session, session.focusedId));
        const l = session.layouts[session.focusedId];
        setCameraExact({ x: -l.x, y: -l.y, z: 1 });
        session.bump();
      } else applyCamera(session, getCamera());
    });
    ro.observe(el);

    const unbind = bindCanvasInput(el, {
      getOrigin: () => session.origin,
      getViewport: () => session.viewport,
      isLocked: () => session.mode !== "explore",
      isFill: () => session.mode === "fill",
      onGestureStart: () => {
        cancelCameraAnimation();
        notifySpotlightGesture();
        markGesture(session);
      },
      onGestureMove: () => {
        session.lastMove = performance.now();
      },
      onPointerDown: (e) => {
        // True means "this press is spoken for, do not pan". Screens belong
        // here too: the canvas used to pan while a frame was being dragged
        // (the frame moved AND everything slid under it), and the pointer
        // capture the pan took retargeted the click, so a frame never saw
        // its own double-click and lock-in was unreachable by mouse.
        const t = e.target;
        if (!(t instanceof Element)) return false;
        if (
          t.closest(
            "[data-screen-id], [data-lab-chrome], [data-notes-host], [data-labels-host], [data-ruler-host]",
          )
        )
          return true;
        return Boolean(session.drag);
      },
      onBackgroundClick: () => exitOne(session),
      onFillPinch: () => {
        if (session.mode === "fill") exitOne(session);
      },
      lastPointer: session.lastPointer,
    });

    const onMove = (e: PointerEvent) => {
      session.lastPointer = { x: e.clientX, y: e.clientY };
      if (session.alt && e.buttons === 0 && session.mode === "explore") {
        const hit = (
          e.target instanceof Element ? e.target.closest("[data-screen-id]") : null
        )?.getAttribute("data-screen-id");
        if (hit !== session.measureHover) {
          session.measureHover = hit ?? null;
          paintMeasure(session);
        }
      }
      if (!session.drag) return;
      if (!session.drag.armed) {
        // Still a click until the pointer travels far enough. Measured in
        // client pixels, because the threshold is about the hand, not the zoom.
        const ax = e.clientX - session.drag.px;
        const ay = e.clientY - session.drag.py;
        if (Math.hypot(ax, ay) < DRAG_THRESHOLD_PX) return;
        session.drag.armed = true;
      }
      const cam = getCamera();
      const dx = (e.clientX - session.drag.px) / cam.z;
      const dy = (e.clientY - session.drag.py) / cam.z;
      const bypass = e.metaKey || e.ctrlKey;
      if (session.drag.kind === "resize") {
        const next = snapResize(
          applyResize(
            session.drag.start,
            session.drag.edge,
            dx,
            dy,
            MIN_FRAME_W,
            MIN_FRAME_H,
          ),
          SNAP_TO_GRID,
          bypass,
        );
        session.drag.current = next;
        writeFrame(session, session.drag.id, next);
        placeChrome(session);
        return;
      }
      const start = session.drag.start;
      const moving = { ...start, x: start.x + dx, y: start.y + dy };
      const dragId = session.drag.id;
      const others = SCREENS.filter((x) => x.id !== dragId).map((x) =>
        liveLayout(session, x.id),
      );
      const snapped = SNAP_TO_GRID
        ? snapMovingBox(
            moving,
            others,
            session.getGuides(),
            SNAP_TOLERANCE_PX / cam.z,
            true,
            bypass,
          )
        : { x: moving.x, y: moving.y, lines: [] };
      const current = { ...start, x: snapped.x, y: snapped.y };
      session.drag.current = current;
      if (session.drag.kind === "ghost") {
        if (session.ghost) {
          session.ghost.style.display = "block";
          session.ghost.style.transform = `translate(${current.x}px, ${current.y}px)`;
          session.ghost.style.width = `${current.width}px`;
          session.ghost.style.height = `${current.height}px`;
        }
      } else {
        writeFrame(session, session.drag.id, current);
      }
      showSnap(session, snapped.lines);
      placeChrome(session);
    };

    const onUp = () => {
      const drag = session.drag;
      if (!drag) return;
      hideSnap(session);
      if (session.ghost) session.ghost.style.display = "none";
      session.drag = null;
      if (!drag.armed) {
        // It was a click. Nothing moved, so there is nothing to commit: no
        // duplicate for an Alt-click, no no-op entry in the undo stack.
        return;
      }
      if (drag.kind === "ghost") {
        const def = screenById(drag.id);
        if (def)
          void duplicateScreen(session, def.dir, {
            x: drag.current.x,
            y: drag.current.y,
          });
        return;
      }
      commitNudge(session);
      const from = drag.start;
      const to = drag.current;
      session.layouts[drag.id] = to;
      if (drag.kind === "resize") {
        pushHistory({ type: "resize", id: drag.id, from, to });
      } else if (from.x !== to.x || from.y !== to.y) {
        pushHistory({
          type: "move",
          id: drag.id,
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
        });
      }
      persist(session);
      session.bump();
    };

    // ── Keyboard: Alt tracking + keyup (runs on both keydown and keyup) ──
    const onKeyMeta = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        session.alt = e.type === "keydown";
        if (!session.alt) {
          session.measureHover = null;
          paintMeasure(session);
        }
      }
    };

    // ── Keyboard: all lab shortcuts (capture phase, keydown only) ──────
    const onKeyDown = (e: KeyboardEvent) => {
      // Plugins get first refusal, in registry order, explore mode only.
      if (session.mode === "explore") {
        for (const p of session.plugins) {
          if (p.handleKey?.(e)) {
            // A shortcut just changed a tool. Only re-render if something is
            // showing that tool's state, so keys stay render-free otherwise.
            if (helpOpenRef.current) session.bump();
            return;
          }
        }
      }

      // Alt tracking for measurement overlay
      onKeyMeta(e);

      // Pure dispatch: decide the action
      const act = dispatchLabKey(
        {
          key: e.key,
          code: e.code,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
        },
        {
          mode: session.mode,
          selectedId: session.selectedId,
          focusedId: session.focusedId,
          hasScreens: SCREENS.length > 0,
          isTypingTarget: isTypingTarget(e.target),
        },
      );
      if (!act) return;
      e.preventDefault();

      // ── Execute action ──────────────────────────────────────────────
      switch (act.action) {
        case "deselect":
          session.selectedId = null;
          session.bump();
          break;
        case "exit-one":
          if (session.mode !== "explore" && session.focusedId) {
            const fn = session.escapers.get(session.focusedId);
            if (fn?.()) return;
          }
          exitOne(session);
          break;
        case "fit-all":
          if (session.mode !== "explore") {
            session.mode = "explore";
            session.focusedId = null;
            session.root?.setAttribute("data-mode", "explore");
            session.bump();
          }
          fitAll(session);
          break;
        case "cycle-select":
          cycle(session, act.direction);
          break;
        case "fill-toggle": {
          const id =
            session.focusedId ?? session.selectedId ?? SCREENS[0]?.id;
          if (!id) break;
          if (session.mode === "fill") exitOne(session);
          else lockInto(session, id, true);
          break;
        }
        case "zoom-step":
          zoomStepAt(
            {
              x: session.viewport.width / 2,
              y: session.viewport.height / 2,
            },
            act.direction,
          );
          markGesture(session);
          break;
        case "zoom-100":
          setCameraExact(
            zoomAt(
              getCamera(),
              {
                x: session.lastPointer.x - session.origin.x,
                y: session.lastPointer.y - session.origin.y,
              },
              1,
            ),
          );
          markGesture(session);
          break;
        case "zoom-to-selection":
          if (session.selectedId) {
            animateCamera(
              getCamera(),
              zoomToBounds(
                session.layouts[session.selectedId],
                session.viewport,
              ),
              session.viewport,
            );
          }
          break;
        case "lock-into":
          if (session.selectedId) lockInto(session, session.selectedId);
          break;
        case "duplicate":
          if (session.selectedId) {
            const def = screenById(session.selectedId);
            if (def) void duplicateScreen(session, def.dir);
          }
          break;
        case "delete-screen":
          if (session.selectedId) {
            void deleteScreen(session, session.selectedId);
          }
          break;
        case "undo":
          commitNudge(session);
          void applyHistory(session, popUndo(), true);
          break;
        case "redo":
          commitNudge(session);
          void applyHistory(session, popRedo(), false);
          break;
        case "cleanup": {
          commitNudge(session);
          const before = { ...session.layouts };
          const order = [...SCREENS]
            .sort(
              (a, b) => session.layouts[a.id].x - session.layouts[b.id].x,
            )
            .map((x) => x.id);
          session.layouts = cleanupRow(
            session.layouts,
            order,
            CLEANUP_GAP,
          );
          pushHistory({
            type: "reset",
            before,
            after: { ...session.layouts },
          });
          saveNow(session.getSnapshot());
          const positions: Record<string, { x: number; y: number }> = {};
          for (const scr of SCREENS) {
            const l = session.layouts[scr.id];
            positions[scr.dir] = { x: l.x, y: l.y };
          }
          void labFs.setPositions(positions);
          session.bump();
          fitAll(session);
          break;
        }
        case "reset-layout": {
          commitNudge(session);
          const before = { ...session.layouts };
          const after: LayoutMap = {};
          for (const scr of SCREENS) {
            after[scr.id] = {
              x: scr.defaultPosition.x,
              y: scr.defaultPosition.y,
              width: scr.width,
              height: scr.height,
            };
          }
          session.layouts = after;
          pushHistory({ type: "reset", before, after });
          persist(session);
          session.bump();
          fitAll(session);
          pushToast("Layout reset");
          break;
        }
        case "nudge": {
          const id = session.selectedId;
          if (!id) break;
          const l = session.layouts[id];
          if (!session.nudge) {
            session.nudge = {
              id,
              from: { x: l.x, y: l.y },
              timer: 0,
            };
          }
          const nx = l.x + act.dx;
          const ny = l.y + act.dy;
          session.layouts[id] = { ...l, x: nx, y: ny };
          writeFrame(session, id, session.layouts[id]);
          placeChrome(session);
          window.clearTimeout(session.nudge.timer);
          session.nudge.timer = window.setTimeout(
            () => commitNudge(session),
            NUDGE_COMMIT_MS,
          );
          break;
        }
      }
    };

    // ── keyup listener for Alt tracking only ──────────────────────────
    const onKeyUp = (e: KeyboardEvent) => {
      onKeyMeta(e);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    __keyboardListenerActive = true;
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("blur", () => {
      session.alt = false;
      paintMeasure(session);
    });

    const notice = takeNotice();
    if (notice) pushToast(notice);
    else if (consumeFirstVisit()) pushToast("Double-click a screen to use it");
    const onPageHide = () => {
      commitNudge(session);
      saveNow(session.getSnapshot());
    };
    window.addEventListener("pagehide", onPageHide);

    const stopSpotlight = attachLabSpotlight({
      getRoot: () => session.root,
      getOrigin: () => session.origin,
      getViewport: () => session.viewport,
    });

    return () => {
      stopSpotlight();
      unbind();
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      __keyboardListenerActive = false;
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pagehide", onPageHide);
      session.disposeExtras();
      attachCameraApplier(null);
      if (session.idleTimer) window.clearTimeout(session.idleTimer);
      if (session.root === el) session.root = null;
    };
  };

  const latestAttach = useRef({ attachRoot, attachLayer, attachGrid });
  latestAttach.current = { attachRoot, attachLayer, attachGrid };
  const stableAttach = useRef({
    root: (el: HTMLDivElement | null) => latestAttach.current.attachRoot(el),
    layer: (el: HTMLDivElement | null) => latestAttach.current.attachLayer(el),
    grid: (el: HTMLCanvasElement | null) => latestAttach.current.attachGrid(el),
  }).current;

  const applyColor = (hex: string) => {
    const next = normalizeHex(hex);
    if (!next) return;
    commitNudge(session);
    const from = canvasColor;
    setCanvasColor(next);
    setHexDraft(next);
    session.canvasColor = next;
    if (from !== next) pushHistory({ type: "canvas", from, to: next });
    applyCamera(session, getCamera());
    persist(session);
  };

  const resetLayout = () => {
    commitNudge(session);
    const before = { ...session.layouts };
    const after: LayoutMap = {};
    for (const scr of SCREENS) {
      after[scr.id] = {
        x: scr.defaultPosition.x,
        y: scr.defaultPosition.y,
        width: scr.width,
        height: scr.height,
      };
    }
    session.layouts = after;
    pushHistory({ type: "reset", before, after });
    persist(session);
    bump();
    fitAll(session);
    pushToast("Layout reset");
  };

  const startMove = (e: React.PointerEvent, id: string, ghost: boolean) => {
    if (session.mode !== "explore") return;
    // Space is held: the canvas is panning from wherever the press landed.
    if (session.root?.hasAttribute("data-space")) return;
    e.stopPropagation();
    session.selectedId = id;
    bump();
    const start = { ...session.layouts[id] };
    session.drag = {
      kind: ghost ? "ghost" : "move",
      id,
      start,
      current: start,
      px: e.clientX,
      py: e.clientY,
      armed: false,
    };
  };

  return (
    <div
      className={styles.root}
      ref={stableAttach.root}
      data-mode={session.mode}
      data-canvas-theme={theme}
      style={{ "--color-canvas": canvasColor } as CSSProperties}
    >
      <canvas className={styles.pixelGrid} ref={stableAttach.grid} />
      <div className={styles.layer} ref={stableAttach.layer}>
        {SCREENS.map((def) => (
          <ScreenSlot
            key={def.id}
            def={def}
            session={session}
            zoom={zoom}
            onShieldPointerDown={(e, id) => {
              if (session.mode !== "explore") {
                if (id !== session.focusedId) exitOne(session);
                return;
              }
              startMove(e, id, e.altKey);
            }}
            onShieldDoubleClick={(id) => lockInto(session, id)}
            onResizePointerDown={(e, id, edge) => {
              e.stopPropagation();
              session.selectedId = id;
              bump();
              const start = { ...session.layouts[id] };
              session.drag = {
                kind: "resize",
                id,
                edge,
                start,
                current: start,
                px: e.clientX,
                py: e.clientY,
                armed: false,
              };
            }}
          />
        ))}
        <div className={styles.notesHost} data-notes-host />
        <div className={styles.labelsHost} data-labels-host />
        <div
          className={styles.ghost}
          ref={(node) => {
            session.ghost = node;
            if (node) node.style.display = "none";
          }}
        />
        <SpotlightOverlay />
      </div>
      <div className={styles.chrome}>
        {SCREENS.map((def) => (
          <ChromeItem
            key={def.id}
            id={def.id}
            session={session}
            name={session.names[def.id] ?? def.name}
            renaming={renaming === def.id}
            showPlay={
              session.selectedId === def.id || session.focusedId === def.id
            }
            showSize={
              session.selectedId === def.id && session.mode === "explore"
            }
            onSelect={() => {
              if (session.mode !== "explore") return;
              session.selectedId = def.id;
              bump();
            }}
            onDrag={(e) => startMove(e, def.id, e.altKey)}
            onFill={() => lockInto(session, def.id, true)}
            onRenameStart={() => setRenaming(def.id)}
            onRenameCommit={(name) => {
              setRenaming(null);
              const from = session.names[def.id] ?? def.name;
              if (!name || name === from) return;
              commitNudge(session);
              session.names[def.id] = name;
              bump();
              pushHistory({
                type: "rename",
                dir: def.dir,
                id: def.id,
                from,
                to: name,
              });
              void labFs.rename(def.dir, name);
            }}
          />
        ))}
      </div>
      <div className={styles.snapX} ref={(node) => { session.snapX = node; }} />
      <div className={styles.snapY} ref={(node) => { session.snapY = node; }} />
      <canvas
        className={styles.measureCanvas}
        ref={(node) => {
          session.measure = node;
        }}
      />
      <div className={styles.rulerHost} data-ruler-host />
      <div
        data-plugin-layer
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
      />
      {pickerOpen ? (
        <div className={styles.popover} data-lab-chrome>
          <div className={styles.swatchRow}>
            {savedColors.map((c) => (
              <button
                key={c}
                type="button"
                style={{ background: c }}
                aria-label={c}
                onClick={() => applyColor(c)}
              />
            ))}
          </div>
          <div className={styles.hexRow}>
            <input
              type="color"
              value={normalizeHex(hexDraft) ?? canvasColor}
              onChange={(e) => applyColor(e.target.value)}
              aria-label="Canvas color"
            />
            <input
              type="text"
              value={hexDraft}
              onChange={(e) => setHexDraft(e.target.value)}
              onBlur={() => applyColor(hexDraft)}
              spellCheck={false}
              aria-label="Hex color"
            />
            <button
              type="button"
              onClick={() => {
                const next = normalizeHex(hexDraft) ?? canvasColor;
                applyColor(next);
                setSavedColors((prev) => {
                  const row = [next, ...prev.filter((c) => c !== next)].slice(0, 10);
                  session.savedColors = row;
                  persist(session);
                  return row;
                });
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.hud} data-lab-chrome>
        <div className={styles.pill}>
          <button
            type="button"
            className={styles.swatch}
            aria-label="Canvas color"
            onClick={() => setPickerOpen((o) => !o)}
          />
          <span className={styles.sep} />
          <button
            type="button"
            className={styles.tool}
            data-on={rulerOn || undefined}
            title="Rulers and guides — Shift R"
            aria-label="Rulers and guides"
            aria-pressed={rulerOn ?? false}
            onClick={() => {
              pressShortcut("KeyR", "R", { shiftKey: true });
              setRev((r) => r + 1);
            }}
          >
            <IconRuler />
          </button>
          <button
            type="button"
            className={styles.tool}
            title="New sticky note — Shift N"
            aria-label="New sticky note"
            onClick={() => pressShortcut("KeyN", "N", { shiftKey: true })}
          >
            <IconNote />
          </button>
          <button
            type="button"
            className={styles.tool}
            title="New label — Shift L"
            aria-label="New label"
            onClick={() => pressShortcut("KeyL", "L", { shiftKey: true })}
          >
            <IconLabel />
          </button>
          <span className={styles.sep} />
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => fitAll(session)}
          >
            {Math.round(zoom * 100)}%
          </button>
          {modeBadge ? <span className={styles.badge}>{modeBadge}</span> : null}
          <button type="button" onClick={resetLayout}>
            Reset layout
          </button>
          <button
            type="button"
            className={styles.zoomBtn}
            title="Shortcuts"
            aria-label="Shortcuts"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((o) => !o)}
          >
            ?
          </button>
        </div>
      </div>
      {helpOpen ? (
        <div className={styles.help} data-lab-chrome>
          {HELP.map((group) => (
            <Fragment key={group.title}>
              <h3 className={styles.helpTitle}>{group.title}</h3>
              {group.rows.map(([keys, what]) => (
                <div className={styles.helpRow} key={what}>
                  <span className={styles.helpKeys}>
                    {keys.map((k) => (
                      <kbd className={styles.key} key={k}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                  <span>{what}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      ) : null}
      <div className={styles.toasts} data-lab-chrome>
        {toasts.map((t) => (
          <div key={t.id} className={styles.toast}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

type ToolToggle = { toggle(): void; isEnabled(): boolean };

const IconRuler = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect
      x="0.85"
      y="4.35"
      width="12.3"
      height="5.3"
      rx="1"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path
      d="M3.6 4.35v1.8M6.2 4.35v2.6M8.8 4.35v1.8M11.4 4.35v2.6"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
  </svg>
);

const IconNote = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M1.9 2.1h10.2v6.6l-3.6 3.2H1.9z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M12.1 8.7H8.5v3.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const IconLabel = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M1.9 2.4c3.4 1.2 6.3 3.9 8.7 8"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <path
      d="M7.3 10.7l3.4-.4-1-3.2"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Every shortcut the lab actually listens for, grouped as it is used.
 * Exported so help-sheet.test.ts can hold it against the real dispatcher —
 * a cheat sheet that lies is worse than none.
 */
export const HELP: { title: string; rows: [string[], string][] }[] = [
  {
    title: "Canvas",
    rows: [
      [["Drag"], "Pan"],
      [["Space", "drag"], "Pan from anywhere"],
      [["Scroll"], "Pan"],
      [["Ctrl", "scroll"], "Zoom to the cursor"],
      [["+"], "Zoom in"],
      [["−"], "Zoom out"],
      [["Shift", "1"], "Fit every screen"],
      [["Shift", "2"], "Zoom to the selection"],
      [["Shift", "0"], "Zoom to 100%"],
    ],
  },
  {
    title: "Screens",
    rows: [
      [["Click"], "Select"],
      [["Drag"], "Move"],
      [["Ctrl", "drag"], "Move, ignoring guides"],
      [["Drag edge"], "Resize"],
      [["Double-click"], "Go into the screen"],
      [["Enter"], "Go into the selected screen"],
      [["Esc"], "Come back out / deselect"],
      [["Shift", "F"], "Full screen"],
      [["Tab"], "Next screen"],
      [["↑↓←→"], "Nudge 1px"],
      [["Shift", "↑↓←→"], "Nudge 10px"],
      [["Alt", "hover"], "Measure the gap"],
    ],
  },
  {
    title: "Files on disk",
    rows: [
      [["Ctrl", "D"], "Duplicate — copies the folder"],
      [["Delete"], "Delete — moves it to .lab-trash"],
      [["Ctrl", "Z"], "Undo"],
      [["Ctrl", "Y"], "Redo"],
      [["Double-click name"], "Rename — rewrites the manifest"],
      [["Ctrl", "C"], "Tidy into one row, and save it"],
      [["Ctrl", "Shift", "⌫"], "Back to the manifest layout"],
    ],
  },
  {
    title: "Tools",
    rows: [
      [["Shift", "R"], "Rulers and guides"],
      [["Ctrl", "Shift", "R"], "Hide the rulers, stay in ruler mode"],
      [["Shift", "N"], "New sticky note"],
      [["Ctrl", "Shift", "N"], "Hide every note"],
      [["Shift", "L"], "New label"],
      [["Ctrl", "Shift", "L"], "Hide every label"],
    ],
  },
];

const ScreenBody = memo(function ScreenBody({
  component: C,
}: {
  component: ScreenDef["component"];
}) {
  return <C />;
});

function ScreenSlot({
  def,
  session,
  zoom,
  onShieldPointerDown,
  onShieldDoubleClick,
  onResizePointerDown,
}: {
  def: ScreenDef;
  session: Session;
  zoom: number;
  onShieldPointerDown: (e: React.PointerEvent, id: string) => void;
  onShieldDoubleClick: (id: string) => void;
  onResizePointerDown: (
    e: React.PointerEvent,
    id: string,
    edge: ResizeEdge,
  ) => void;
}) {
  // Re-render this one screen while its frame is being resized, so the app
  // inside it reflows during the drag instead of after it. Only this slot
  // subscribes, so a resize never renders the rest of the lab.
  useSyncExternalStore(
    useMemo(() => (fn: () => void) => subscribeFrame(def.id, fn), [def.id]),
    () => frameTick(def.id),
  );
  const layout = liveLayout(session, def.id);
  const active = session.focusedId === def.id && session.mode !== "explore";
  const selected = session.selectedId === def.id;
  const visible = session.visible[def.id] !== false;
  const env = useMemo(
    () => ({
      screenId: def.id,
      active,
      visible,
      frameSize: { width: layout.width, height: layout.height },
      zoom,
      clientToFrame: (p: { clientX: number; clientY: number }) => {
        const scroll = session.root?.querySelector(
          `[data-screen-scroll="${def.id}"]`,
        );
        if (!(scroll instanceof HTMLElement) || scroll.clientWidth === 0) {
          return { x: 0, y: 0 };
        }
        const rect = scroll.getBoundingClientRect();
        const scale = rect.width / scroll.clientWidth;
        return {
          x: (p.clientX - rect.left) / scale + scroll.scrollLeft,
          y: (p.clientY - rect.top) / scale + scroll.scrollTop,
        };
      },
      setEscapeInterceptor: (fn: (() => boolean) | null) => {
        if (fn) session.escapers.set(def.id, fn);
        else session.escapers.delete(def.id);
      },
    }),
    [def.id, active, visible, layout.width, layout.height, zoom, session],
  );

  return (
    <ScreenFrame
      id={def.id}
      layout={layout}
      selected={selected}
      active={active}
      dimmed={session.mode !== "explore" && !active}
      showHandles={selected && session.mode === "explore"}
      env={env}
      onShieldPointerDown={onShieldPointerDown}
      onShieldDoubleClick={onShieldDoubleClick}
      onResizePointerDown={onResizePointerDown}
    >
      <ScreenBody component={def.component} />
    </ScreenFrame>
  );
}

function ChromeItem({
  id,
  session,
  name,
  renaming,
  showPlay,
  showSize,
  onSelect,
  onDrag,
  onFill,
  onRenameStart,
  onRenameCommit,
}: {
  id: string;
  session: Session;
  name: string;
  renaming: boolean;
  showPlay: boolean;
  showSize: boolean;
  onSelect: () => void;
  onDrag: (e: React.PointerEvent) => void;
  onFill: () => void;
  onRenameStart: () => void;
  onRenameCommit: (name: string) => void;
}) {
  const layout = liveLayout(session, id);
  return (
    <div
      className={styles.chromeItem}
      data-screen-id={id}
      ref={(node) => {
        if (!node) return;
        session.chrome.set(id, node);
        const cam = getCamera();
        node.style.transform = `translate(${(layout.x + cam.x) * cam.z}px, ${(layout.y + cam.y) * cam.z}px)`;
        node.style.width = `${layout.width * cam.z}px`;
        return () => {
          session.chrome.delete(id);
        };
      }}
    >
      <div
        className={styles.label}
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect();
          if (e.detail < 2) onDrag(e);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onRenameStart();
        }}
      >
        {renaming ? (
          <input
            className={styles.labelInput}
            defaultValue={name}
            autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => onRenameCommit(e.currentTarget.value.trim())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRenameCommit(e.currentTarget.value.trim());
              }
              if (e.key === "Escape") onRenameCommit(name);
            }}
          />
        ) : (
          name
        )}
      </div>
      {showPlay ? (
        <button
          type="button"
          className={styles.play}
          aria-label="Fill mode"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onFill();
          }}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 1.5v7l7-3.5z" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      {showSize ? (
        <div className={styles.sizeBadge}>
          {Math.round(layout.width)} × {Math.round(layout.height)}
        </div>
      ) : null}
    </div>
  );
}
