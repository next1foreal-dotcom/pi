/**
 * The Studio's drag-to-resize split-pane grid, moved into a lab frame.
 *
 * Ported from `samantha-ui/src/components/mosaic-pane-host.tsx` (474 lines).
 * The layout, the metrics and the feel are the original's: 360px column floor,
 * 140px row floor, a 240ms `grid-template-columns` transition, double-click a
 * grip to even-split, unfocused panes dimmed to `opacity(.75) saturate(.85)`,
 * ctrl+] / ctrl+[ to cycle and ctrl+alt+arrow to move by geometry. A drag still
 * writes `--mosaic-cols` / `flex-grow` straight to the DOM and touches the
 * model once, on pointerup.
 *
 * What changed is where the numbers come from. In the Studio this component
 * owns the whole window, so "one client pixel" and "one CSS pixel of my own
 * layout" are the same thing. Inside a lab frame they are not: the frame sits
 * under a camera transform, so
 *
 *   - a `getBoundingClientRect()` width is the LAID-OUT width times the camera
 *     zoom. At a fit-all zoom it is a fraction of the truth, and the 360px
 *     column floor computed from it comes out several times too large;
 *   - a `clientX` delta is a screen distance. The frame distance the user
 *     actually asked for is `delta / zoom`.
 *
 * So every width and height here is read from layout (`offsetWidth` /
 * `offsetHeight`, which the transform does not touch) and every pointer delta
 * is divided by `zoom` from `useScreen()`. The two together are exactly a
 * no-op at zoom 1, which is why this was invisible in the Studio.
 *
 * The global pointermove/up listeners stayed global — a drag that leaves the
 * frame must still track — and the keyboard listeners stayed on `window`, but
 * they now gate on `active` so an inert screen sitting across the canvas
 * cannot eat the lab's own shortcuts.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { useScreen } from "../../../lab/screen-context";
import {
  applyColumnLayout,
  applyPaneLayout,
  evenSplitAdjacentColumns,
  evenSplitColumnRows,
  mosaicColumnId,
  type MosaicModel,
  type MosaicPaneId,
} from "../model";

/** A column narrower than this is unusable; Claude Desktop uses the same 360. */
export const COL_MIN_PX = 360;
/** Row floor. Ours, not Claude's — Her stacks up to seven tool panes. */
export const ROW_MIN_PX = 140;

type PanePos = { col: number; row: number };

function trackList(sizes: number[]): string {
  return sizes.map((s) => `${s}fr`).join(" ");
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function MosaicPaneHost({
  model,
  onLayout,
  renderPane,
  onClosePane,
}: {
  model: MosaicModel;
  /** Called once per gesture, on pointerup — never mid-drag. */
  onLayout: (next: MosaicModel) => void;
  renderPane: (id: MosaicPaneId) => ReactNode;
  /** Close the focused pane (ctrl+alt+W). Whatever "close" means per pane kind
   *  is the caller's business — this only knows which pane has the ring. */
  onClosePane?: (id: MosaicPaneId) => void;
}) {
  const { active, zoom } = useScreen();
  const hostRef = useRef<HTMLDivElement>(null);
  const [focusChoice, setFocusChoice] = useState<MosaicPaneId | null>(null);

  /** Flat pane order + geometry, the basis for both focus and keyboard moves. */
  const positions = useMemo(() => {
    const out = new Map<MosaicPaneId, PanePos>();
    const order: MosaicPaneId[] = [];
    model.columns.forEach((col, ci) =>
      col.panes.forEach((pane, ri) => {
        out.set(pane.id, { col: ci, row: ri });
        order.push(pane.id);
      }),
    );
    return { byId: out, order };
  }, [model]);

  const split = positions.order.length > 1;

  /**
   * Derived, not synced: closing the focused pane simply falls back to the
   * first one. An effect that repaired the state instead would fire a second
   * render on every model change.
   */
  const focused: MosaicPaneId | null =
    focusChoice && positions.byId.has(focusChoice)
      ? focusChoice
      : (positions.order[0] ?? null);

  /**
   * Single source of truth for the geometry the browser actually sees. Runs
   * after every render (cheap: a handful of property writes) so a committed
   * model always overwrites whatever a drag left behind.
   *
   * `host.querySelector`, not `document.querySelector`: the lab mounts four
   * screens into one document and two of them could hold a mosaic.
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.style.setProperty(
      "--mosaic-cols",
      trackList(model.columns.map((c) => c.size)),
    );
    model.columns.forEach((col, ci) => {
      col.panes.forEach((pane) => {
        const el = host.querySelector<HTMLElement>(
          `[data-col="${ci}"] > [data-pane="${pane.id}"]`,
        );
        if (el) el.style.flexGrow = String(pane.size);
      });
    });
  });

  /**
   * Claude's rescue rule: if the frame got narrow enough that a column fell
   * under the floor, snap every column back to equal rather than leave slivers.
   * Guarded so it can't fight a frame that simply cannot fit them all.
   *
   * The trigger is a `ResizeObserver` on our own root, never a window resize
   * listener: the window is the whole lab, and this screen is one frame in it.
   * `offsetWidth`, never a rect — see the file header.
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const check = () => {
      const cols = model.columns;
      if (cols.length <= 1) return;
      const width = host.offsetWidth;
      if (width <= 0 || COL_MIN_PX * cols.length > width) return;
      const total = sum(cols.map((c) => c.size)) || 100;
      const thinnest = Math.min(...cols.map((c) => (c.size / total) * width));
      if (thinnest >= COL_MIN_PX) return;
      onLayout(
        applyColumnLayout(
          model,
          Object.fromEntries(
            cols.map((_, i) => [mosaicColumnId(i), 100 / cols.length]),
          ),
        ),
      );
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(host);
    return () => observer.disconnect();
  }, [model, onLayout]);

  const startColResize = useCallback(
    (index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const host = hostRef.current;
      if (event.button !== 0 || !host) return;
      // Deliberately no preventDefault here: it also suppresses the compatibility
      // click/dblclick the browser synthesises afterwards, which would silently
      // kill double-click-to-reset on any grip that had once been dragged.
      // Selection is held off by body.userSelect below and touch-action in CSS.
      event.stopPropagation();

      const grip = event.currentTarget;
      // Layout width, not `getBoundingClientRect().width`: the camera scales
      // the rect, and COL_MIN_PX is a frame pixel.
      const width = Math.max(1, host.offsetWidth);
      const scale = zoom || 1;
      const start = model.columns.map((c) => c.size);
      const total = sum(start) || 100;
      const pair = start[index] + start[index + 1];
      const floor = Math.min((COL_MIN_PX / width) * total, pair / 2);
      const originX = event.clientX;
      let live = start;

      host.setAttribute("data-resizing", "");
      grip.setAttribute("data-active", "");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        ev.preventDefault();
        // The listener is on `document` so a drag can leave the frame, but the
        // coordinate it carries is a screen pixel: `/ scale` turns it into the
        // frame pixel the user actually asked for.
        const frameDelta = (ev.clientX - originX) / scale;
        const delta = (frameDelta / width) * total;
        const head = Math.min(
          pair - floor,
          Math.max(floor, start[index] + delta),
        );
        const next = start.slice();
        next[index] = head;
        next[index + 1] = pair - head;
        live = next;
        host.style.setProperty("--mosaic-cols", trackList(next));
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        host.removeAttribute("data-resizing");
        grip.removeAttribute("data-active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (live !== start) {
          onLayout(
            applyColumnLayout(
              model,
              Object.fromEntries(
                live.map((size, i) => [mosaicColumnId(i), size]),
              ),
            ),
          );
        }
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [model, onLayout, zoom],
  );

  const startRowResize = useCallback(
    (colIndex: number, rowIndex: number) =>
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const host = hostRef.current;
        if (event.button !== 0 || !host) return;
        const colEl = host.querySelector<HTMLElement>(
          `[data-col="${colIndex}"]`,
        );
        const panes = model.columns[colIndex]?.panes;
        if (!colEl || !panes) return;
        const headEl = colEl.querySelector<HTMLElement>(
          `[data-pane="${panes[rowIndex].id}"]`,
        );
        const tailEl = colEl.querySelector<HTMLElement>(
          `[data-pane="${panes[rowIndex + 1].id}"]`,
        );
        if (!headEl || !tailEl) return;
        // Same reason as the column grip: no preventDefault on pointerdown, or
        // double-click-to-reset dies after the first drag.
        event.stopPropagation();

        const grip = event.currentTarget;
        // Layout height, not a rect — see the column grip.
        const height = Math.max(1, colEl.offsetHeight);
        const scale = zoom || 1;
        const start = panes.map((p) => p.size);
        const total = sum(start) || 100;
        const pair = start[rowIndex] + start[rowIndex + 1];
        const floor = Math.min((ROW_MIN_PX / height) * total, pair / 2);
        const originY = event.clientY;
        let live = start;

        host.setAttribute("data-resizing", "");
        grip.setAttribute("data-active", "");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";

        const onMove = (ev: PointerEvent) => {
          ev.preventDefault();
          const frameDelta = (ev.clientY - originY) / scale;
          const delta = (frameDelta / height) * total;
          const head = Math.min(
            pair - floor,
            Math.max(floor, start[rowIndex] + delta),
          );
          const next = start.slice();
          next[rowIndex] = head;
          next[rowIndex + 1] = pair - head;
          live = next;
          headEl.style.flexGrow = String(head);
          tailEl.style.flexGrow = String(pair - head);
        };

        const onUp = () => {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
          host.removeAttribute("data-resizing");
          grip.removeAttribute("data-active");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          if (live !== start) {
            onLayout(
              applyPaneLayout(
                model,
                colIndex,
                Object.fromEntries(
                  live.map((size, i) => [panes[i].id, size] as const),
                ),
              ),
            );
          }
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
      },
    [model, onLayout, zoom],
  );

  const evenSplitColumnsAt = useCallback(
    (index: number) => () => {
      onLayout(evenSplitAdjacentColumns(model, index));
    },
    [model, onLayout],
  );

  const evenSplitRowsIn = useCallback(
    (colIndex: number) => () => {
      onLayout(evenSplitColumnRows(model, colIndex));
    },
    [model, onLayout],
  );

  /**
   * Ctrl/⌘ held marks the host so the CSS can offer the whole pane as a drag
   * handle. Cleared on blur too — otherwise alt-tabbing away mid-hold leaves the
   * mosaic stuck in grab mode.
   *
   * Gated on `active`: in explore mode this screen is a picture on a canvas,
   * and a picture must not react to the lab operator's modifier keys.
   */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !active) return;
    const held = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;
    const onDown = (e: KeyboardEvent) => {
      if (e.getModifierState?.("AltGraph")) return;
      if (held(e)) host.setAttribute("data-cmd-held", "");
    };
    const onUp = (e: KeyboardEvent) => {
      if (!held(e)) host.removeAttribute("data-cmd-held");
    };
    const clear = () => host.removeAttribute("data-cmd-held");
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [active]);

  /**
   * Move the focus ring without touching the mouse.
   *
   * `active` is the whole point of the gate: the listener is on `window`, so
   * an inert mosaic parked elsewhere on the canvas would answer ctrl+] while
   * the operator was aiming it at something else entirely.
   */
  useEffect(() => {
    if (!split || !active) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || ev.shiftKey) return;
      // AltGr reports as ctrl+alt on several Windows layouts.
      if (ev.getModifierState?.("AltGraph")) return;
      // The terminal owns ctrl+[ (it is ESC); text fields own their own keys.
      // `instanceof Element` matters: a keydown retargeted to window/document
      // has no `closest`, and calling it would throw and kill the shortcut.
      const target = ev.target;
      if (
        target instanceof Element &&
        target.closest(
          ".xterm, input, textarea, select, [contenteditable='true']",
        )
      ) {
        return;
      }

      const order = positions.order;
      const current = focused ? order.indexOf(focused) : -1;
      if (current < 0) return;

      // ctrl+alt+W closes the focused pane, same combo Claude Desktop uses.
      if (ev.ctrlKey && ev.altKey && !ev.metaKey && ev.code === "KeyW") {
        if (!focused || !onClosePane) return;
        ev.preventDefault();
        onClosePane(focused);
        return;
      }

      if (ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const step =
          ev.code === "BracketRight" ? 1 : ev.code === "BracketLeft" ? -1 : 0;
        if (step === 0) return;
        ev.preventDefault();
        setFocusChoice(order[(current + step + order.length) % order.length]);
        return;
      }

      if (!ev.ctrlKey || !ev.altKey || ev.metaKey) return;
      if (!ev.code.startsWith("Arrow")) return;
      const here = positions.byId.get(order[current]);
      if (!here) return;

      let next: MosaicPaneId | undefined;
      if (ev.code === "ArrowUp" || ev.code === "ArrowDown") {
        const row = here.row + (ev.code === "ArrowDown" ? 1 : -1);
        next = model.columns[here.col]?.panes[row]?.id;
      } else {
        const col = here.col + (ev.code === "ArrowRight" ? 1 : -1);
        const panes = model.columns[col]?.panes;
        // Landing in a shorter stack lands on its last pane, not nowhere.
        next = panes?.[Math.min(here.row, panes.length - 1)]?.id;
      }
      if (!next) return;
      ev.preventDefault();
      setFocusChoice(next);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [split, active, focused, positions, model, onClosePane]);

  // Put the caret where the ring went, so typing follows the focus. Also gated
  // on `active`: an inert screen that grabbed the caret on mount would take the
  // keyboard away from the lab the moment it scrolled into view.
  useLayoutEffect(() => {
    if (!split || !focused || !active) return;
    const el = hostRef.current?.querySelector<HTMLElement>(
      `[data-pane="${focused}"]`,
    );
    if (el && !el.contains(document.activeElement)) {
      el.focus({ preventScroll: true });
    }
  }, [focused, split, active]);

  return (
    <div
      ref={hostRef}
      className="mos-host"
      data-mosaic-host
      data-split={split || undefined}
      data-pane-count={positions.order.length}
    >
      {model.columns.map((col, ci) => (
        <div key={mosaicColumnId(ci)} className="mos-col" data-col={ci}>
          {col.panes.map((pane, ri) => (
            <Fragment key={pane.id}>
              {ri > 0 && (
                <div className="mos-row-grip-slot">
                  <div
                    className="mos-row-grip"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize panes"
                    onPointerDown={startRowResize(ci, ri - 1)}
                    onDoubleClick={evenSplitRowsIn(ci)}
                  />
                </div>
              )}
              <div
                className="mos-pane"
                data-pane={pane.id}
                // Always marked, not only when split: the narrow-frame rule in
                // the stylesheet shows the focused pane and hides the rest, so
                // it needs a focused pane to exist even with a single one open.
                // The dimming stays gated on [data-split] in CSS.
                data-focused={focused === pane.id ? "" : undefined}
                tabIndex={-1}
                onPointerDownCapture={() => setFocusChoice(pane.id)}
                onFocusCapture={() => setFocusChoice(pane.id)}
              >
                {renderPane(pane.id)}
              </div>
            </Fragment>
          ))}
          {ci < model.columns.length - 1 && (
            <div
              className="mos-col-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize columns"
              onPointerDown={startColResize(ci)}
              onDoubleClick={evenSplitColumnsAt(ci)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
