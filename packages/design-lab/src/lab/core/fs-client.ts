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

export const labFs = {
  duplicate: (dir: string) => post("/duplicate", { dir }),
  delete: (dir: string) => post("/delete", { dir }),
  restore: (token: string) => post("/restore", { token }),
  rename: (dir: string, name: string) => post("/rename", { dir, name }),
  setPositions: (positions: Record<string, { x: number; y: number }>) =>
    post("/set-positions", { positions }),
};
