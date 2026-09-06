export type FsResult = {
  ok: boolean;
  error?: string;
  dir?: string;
  token?: string;
};

async function post(path: string, body: unknown): Promise<FsResult> {
  try {
    const res = await fetch(`/__lab-fs${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as FsResult;
  } catch {
    return { ok: false, error: "dev-server-only" };
  }
}

/**
 * GET a text endpoint under /__lab-fs. Returns the body as a string, or
 * `{ ok: false }` when the dev server is unreachable or the route 404s.
 * Failures are silent — the lab must mount even without a dev server.
 */
async function getText(path: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/__lab-fs${path}`);
    if (!res.ok) return { ok: false, error: `status ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false, error: "dev-server-only" };
  }
}

export const labFs = {
  duplicate: (dir: string) => post("/duplicate", { dir }),
  delete: (dir: string) => post("/delete", { dir }),
  restore: (token: string) => post("/restore", { token }),
  rename: (dir: string, name: string) => post("/rename", { dir, name }),
  setPositions: (positions: Record<string, { x: number; y: number }>) =>
    post("/set-positions", { positions }),
  /** Fetch the persisted scratch-set CSS (if any). Silent on failure. */
  scratchCss: () => getText("/scratch-tokens.css"),
};
