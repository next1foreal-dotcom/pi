import type { Camera, PersistedV1, ScreenLayout } from "./types";

export const STORAGE_KEY = "interaction-lab:v1";
export const DEFAULT_CANVAS = "#f1f1f1";

const SAVE_MS = 300;

let saveTimer = 0;

export function loadPersisted(): PersistedV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedV1;
    if (!data || typeof data !== "object") return null;
    if (!isCamera(data.camera)) return null;
    if (!data.screens || typeof data.screens !== "object") data.screens = {};
    return data;
  } catch {
    return null;
  }
}

export function savePersisted(state: PersistedV1): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // private mode / quota — keep going in-memory
  }
}

export function scheduleSave(state: PersistedV1): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    savePersisted(state);
  }, SAVE_MS);
}

export function saveNow(state: PersistedV1): void {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  savePersisted(state);
}

export function dropUnknownIds(
  screens: PersistedV1["screens"],
  known: ReadonlySet<string>,
): PersistedV1["screens"] {
  const out: PersistedV1["screens"] = {};
  for (const id of Object.keys(screens)) {
    if (known.has(id)) out[id] = screens[id];
  }
  return out;
}

function isCamera(c: unknown): c is Camera {
  if (!c || typeof c !== "object") return false;
  const o = c as Camera;
  return (
    typeof o.x === "number" &&
    typeof o.y === "number" &&
    typeof o.z === "number" &&
    Number.isFinite(o.x) &&
    Number.isFinite(o.y) &&
    Number.isFinite(o.z)
  );
}

export function overlayLayout(
  id: string,
  defaults: ScreenLayout,
  overrides: PersistedV1["screens"],
): ScreenLayout {
  const o = overrides[id];
  return {
    x: typeof o?.x === "number" ? o.x : defaults.x,
    y: typeof o?.y === "number" ? o.y : defaults.y,
    width: typeof o?.width === "number" ? o.width : defaults.width,
    height: typeof o?.height === "number" ? o.height : defaults.height,
  };
}

const HINT_KEY = "interaction-lab:hint:v1";

export function consumeFirstVisit(): boolean {
  try {
    if (localStorage.getItem(HINT_KEY)) return false;
    localStorage.setItem(HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}
