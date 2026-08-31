/**
 * Pure keyboard dispatch for the Interaction Lab.
 *
 * Maps (key + modifiers + target-kind + mode + state) to an action descriptor
 * or null. No DOM access, no side effects — the caller owns addEventListener,
 * preventDefault, and effect execution.
 *
 * Every returned action implies the caller must call `e.preventDefault()`.
 */

import type { Mode } from "./types";

// ───────────────────────────── action types ─────────────────────────────

export type KeyAction =
  | { action: "cycle-select"; direction: 1 | -1 }
  | { action: "lock-into" }
  | { action: "deselect" }
  | { action: "exit-one" }
  | { action: "fit-all" }
  | { action: "zoom-to-selection" }
  | { action: "zoom-100" }
  | { action: "fill-toggle" }
  | { action: "duplicate" }
  | { action: "delete-screen" }
  | { action: "undo" }
  | { action: "redo" }
  | { action: "zoom-step"; direction: 1 | -1 }
  | { action: "nudge"; dx: number; dy: number }
  | { action: "cleanup" }
  | { action: "reset-layout" };

// ───────────────────────────── inputs ────────────────────────────────

export type KeyInput = {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

export type DispatchContext = {
  mode: Mode;
  selectedId: string | null;
  focusedId: string | null;
  hasScreens: boolean;
  isTypingTarget: boolean;
};

// ───────────────────────────── helpers ────────────────────────────────

const NUDGE_SMALL = 1;
const NUDGE_BIG = 10;

// ───────────────────────────── dispatch ──────────────────────────────

/**
 * Pure decision: given a keydown event's properties and the current lab
 * state, return the action the lab should execute, or null if the event
 * should be ignored (passed through to the app / browser).
 */
export function dispatchLabKey(
  input: KeyInput,
  ctx: DispatchContext,
): KeyAction | null {
  const { key, code, shiftKey, ctrlKey, metaKey, altKey } = input;
  const meta = metaKey || ctrlKey;
  const explore = ctx.mode === "explore";

  // ── Escape: always handled, even on typing targets ──────────────
  if (key === "Escape") {
    if (explore) return { action: "deselect" };
    return { action: "exit-one" };
  }

  // ── Typing target gates everything else ─────────────────────────
  if (ctx.isTypingTarget) return null;

  // ── All-modes shortcuts (before the !explore gate) ──────────────

  // Shift+1  →  fit all (in locked mode: exit first, then fit)
  if (code === "Digit1" && shiftKey && !meta) {
    return { action: "fit-all" };
  }

  // Tab / Shift+Tab  →  cycle selection
  if (key === "Tab") {
    return { action: "cycle-select", direction: shiftKey ? -1 : 1 };
  }

  // Shift+F  →  toggle fill mode
  if (code === "KeyF" && shiftKey && !meta) {
    return { action: "fill-toggle" };
  }

  // ── Locked-in mode: only zoom +/- in focus, nothing else ────────
  if (!explore) {
    if (
      ctx.mode === "focus" &&
      (key === "+" || key === "=" || key === "-" || code === "Minus")
    ) {
      const dir: 1 | -1 = key === "-" || code === "Minus" ? -1 : 1;
      return { action: "zoom-step", direction: dir };
    }
    return null;
  }

  // ── Explore-only shortcuts ──────────────────────────────────────

  // Zoom in
  if (key === "+" || key === "=" || code === "Equal") {
    return { action: "zoom-step", direction: 1 };
  }
  // Zoom out
  if (key === "-" || code === "Minus") {
    return { action: "zoom-step", direction: -1 };
  }

  // Shift+0  →  zoom to 100 % at cursor
  if (code === "Digit0" && shiftKey && !meta) {
    return { action: "zoom-100" };
  }

  // Shift+2  →  zoom to selected screen (no lock-in)
  if (code === "Digit2" && shiftKey && !meta && ctx.selectedId) {
    return { action: "zoom-to-selection" };
  }

  // Enter  →  lock into selected screen
  if (key === "Enter" && ctx.selectedId) {
    return { action: "lock-into" };
  }

  // ⌘ D  →  duplicate selected screen
  if (code === "KeyD" && meta && ctx.selectedId) {
    return { action: "duplicate" };
  }

  // Delete / Backspace  →  delete selected screen
  if (
    (key === "Delete" || key === "Backspace") &&
    ctx.selectedId &&
    !shiftKey
  ) {
    return { action: "delete-screen" };
  }

  // ⌘ Z / ⌘ Shift Z  →  undo / redo
  if (code === "KeyZ" && meta && !altKey) {
    return shiftKey ? { action: "redo" } : { action: "undo" };
  }

  // Ctrl+Y  →  redo (Windows convention)
  if (code === "KeyY" && ctrlKey && !metaKey) {
    return { action: "redo" };
  }

  // Ctrl+C (no ⌘)  →  cleanup row
  if (code === "KeyC" && ctrlKey && !metaKey && !shiftKey && !altKey) {
    return { action: "cleanup" };
  }

  // Shift+⌘+Backspace  →  reset layout
  if ((key === "Backspace" || code === "Backspace") && shiftKey && meta) {
    return { action: "reset-layout" };
  }

  // Arrow keys  →  nudge selected screen
  if (ctx.selectedId && key.startsWith("Arrow")) {
    const step = shiftKey ? NUDGE_BIG : NUDGE_SMALL;
    let dx = 0;
    let dy = 0;
    if (key === "ArrowLeft") dx = -step;
    if (key === "ArrowRight") dx = step;
    if (key === "ArrowUp") dy = -step;
    if (key === "ArrowDown") dy = step;
    if (dx !== 0 || dy !== 0) {
      return { action: "nudge", dx, dy };
    }
  }

  return null;
}
