const KEY = "interaction-lab:history:v1";
const CAP = 50;

export type LayoutMap = Record<
  string,
  { x: number; y: number; width: number; height: number }
>;

export type HistoryCommand =
  | {
      type: "move";
      id: string;
      from: { x: number; y: number };
      to: { x: number; y: number };
    }
  | {
      type: "resize";
      id: string;
      from: LayoutMap[string];
      to: LayoutMap[string];
    }
  | { type: "reset"; before: LayoutMap; after: LayoutMap }
  | { type: "canvas"; from: string; to: string }
  | {
      type: "delete";
      id: string;
      dir: string;
      token: string;
      layout: LayoutMap[string];
    }
  | {
      type: "duplicate";
      id: string;
      dir: string;
      copyDir: string;
      copyId: string;
    }
  | { type: "rename"; dir: string; id: string; from: string; to: string };

type Stacks = { undo: HistoryCommand[]; redo: HistoryCommand[] };

function load(): Stacks {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { undo: [], redo: [] };
    const data = JSON.parse(raw) as Stacks;
    if (!Array.isArray(data.undo) || !Array.isArray(data.redo)) {
      return { undo: [], redo: [] };
    }
    return data;
  } catch {
    return { undo: [], redo: [] };
  }
}

function save(s: Stacks): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // quota
  }
}

export function pushHistory(cmd: HistoryCommand): void {
  const s = load();
  s.undo = [...s.undo, cmd].slice(-CAP);
  s.redo = [];
  save(s);
}

export function popUndo(): HistoryCommand | null {
  const s = load();
  const cmd = s.undo.pop();
  if (!cmd) return null;
  s.redo.push(cmd);
  save(s);
  return cmd;
}

export function popRedo(): HistoryCommand | null {
  const s = load();
  const cmd = s.redo.pop();
  if (!cmd) return null;
  s.undo.push(cmd);
  save(s);
  return cmd;
}

export function peekUndo(): HistoryCommand | null {
  const s = load();
  return s.undo[s.undo.length - 1] ?? null;
}

export function saveHistoryNow(): void {
  save(load());
}

export function setNotice(text: string): void {
  try {
    sessionStorage.setItem("interaction-lab:notice", text);
  } catch {
    // ignore
  }
}

export function takeNotice(): string | null {
  try {
    const t = sessionStorage.getItem("interaction-lab:notice");
    if (t) sessionStorage.removeItem("interaction-lab:notice");
    return t;
  } catch {
    return null;
  }
}
