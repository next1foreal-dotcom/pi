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
  | { type: "rename"; dir: string; id: string; from: string; to: string }
  | {
      type: "source-edit";
      /** Which of the three element writes this step goes back through. */
      endpoint: SourceEditEndpoint;
      /** One line of his own language, for the toast when a step is refused. */
      what: string;
      undo: SourceEditDirection;
      redo: SourceEditDirection;
    };

/** The three routes that rewrite his source from the canvas. */
export type SourceEditEndpoint = "classes" | "text" | "prop";

/**
 * One direction of a source edit: the request that applies it, and the state of
 * the file it may be applied to.
 *
 * Both halves are worked out by whoever made the edit, at the moment it landed,
 * and carried here as plain data. The alternative -- deriving the reverse from
 * the `before` the server hands back -- would mean parsing his JSX a fourth
 * time, in a fourth place, kept in step with the other three by hand.
 *
 * `expect` is the whole reason this is safe to replay later. Between the edit
 * and the Ctrl+Z, that line can have changed: he edited it in his editor, or
 * she did. Sending the reverse write blind would overwrite that silently, and
 * he would believe he had taken one step back.
 */
export type SourceEditDirection = {
  /** The endpoint's own body, minus `expect`. */
  body: Record<string, unknown>;
  /** What that write must be replacing, or null for "nothing is there". */
  expect: string | null;
};

/**
 * The `before`/`after` the endpoints answer with, as an `expect`.
 *
 * They say "" for a tag that has no such attribute at all -- no `className`, no
 * `tone=`. Null is how the wire says that, because "" is also a legal value for
 * an attribute that IS there (`className=""`), and an undo that could not tell
 * those apart would put the attribute back where it never was.
 */
export function expectFor(value: string): string | null {
  return value === "" ? null : value;
}

export type SourceEditOutcome = { ok: true } | { ok: false; note: string };

/** The header those routes require. Writing source from a browser earns it. */
const WRITE_GUARD = "x-lab-canvas";

/**
 * Send one direction of a source edit and say plainly whether it landed.
 *
 * A refusal comes back as the server's own sentence. It knows what it expected
 * and what it found instead; anything friendlier written here would be a
 * paraphrase of the one piece of information he needs.
 */
export async function sendSourceEdit(
  endpoint: SourceEditEndpoint,
  dir: SourceEditDirection,
): Promise<SourceEditOutcome> {
  let status = 0;
  let reply: { ok?: unknown; error?: unknown } = {};
  try {
    const res = await fetch(`/__lab-fs/element/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", [WRITE_GUARD]: "1" },
      body: JSON.stringify({ ...dir.body, expect: dir.expect }),
    });
    status = res.status;
    try {
      reply = (await res.json()) as { ok?: unknown; error?: unknown };
    } catch {
      reply = {};
    }
  } catch (error) {
    // The dev server is gone, or the page is being torn down. Reporting this
    // as a success would leave the step off the stack and the file unchanged.
    return { ok: false, note: String(error) };
  }
  if (status >= 200 && status < 300 && reply.ok === true) return { ok: true };
  const said =
    typeof reply.error === "string" && reply.error.trim() !== ""
      ? reply.error
      : `写不进去(HTTP ${status})`;
  return { ok: false, note: said };
}

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
