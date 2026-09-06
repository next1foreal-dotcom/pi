import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";
import { stampOidOnEvent } from "../her/src/design-canvas/store.ts";

type Positions = Record<string, { x: number; y: number }>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function uniqueDir(parent: string, base: string): string {
  let name = `${base}-copy`;
  let n = 2;
  while (fs.existsSync(path.join(parent, name))) {
    name = `${base}-copy-${n++}`;
  }
  return name;
}

function patchExport(src: string, key: string, value: string): string {
  const re = new RegExp(`(export\\s+const\\s+${key}\\s*=\\s*)(["'\`])([\\s\\S]*?)\\2`);
  if (re.test(src)) return src.replace(re, `$1$2${value}$2`);
  return `${src}\nexport const ${key} = ${JSON.stringify(value)};\n`;
}

function patchPosition(src: string, x: number, y: number): string {
  const re =
    /export\s+const\s+position\s*=\s*\{\s*x:\s*[-0-9.]+,\s*y:\s*[-0-9.]+\s*\}/;
  const next = `export const position = { x: ${x}, y: ${y} }`;
  if (re.test(src)) return src.replace(re, next);
  return `${src}\n${next};\n`;
}

/**
 * The feedback feed: what Fei writes on the canvas, and what she writes back.
 * Lives in her data directory, not the lab's, because the canvas is a viewer
 * and the conversation is hers to keep. Append-only, one JSON event per line —
 * a record's position is its sequence, so the two writers (this dev server and
 * her runtime) never pick a number and never collide on one.
 * Semantics and the reader live in packages/her/src/design-canvas/.
 */
const FEED_REL = ["design", "canvas", "feed.jsonl"];

/**
 * Writes must carry this header.
 *
 * A JSON body sent as text/plain is a CORS-*simple* request, so without it any
 * page the browser visits — including a screen whose markup she generated from
 * something she read — could POST here. Since `author` is what makes a note
 * read as Fei, that would be a path for generated content to issue instructions
 * to her in his name. A simple request cannot set a custom header, and the
 * browser route cannot claim authorship anyway: the server stamps it.
 * (The reasoning is tracepaper's; the code is ours.)
 */
const WRITE_GUARD = "x-lab-canvas";

const EVENT_TYPES = new Set([
  "note",
  "note.move",
  "note.edit",
  "note.delete",
  "reply",
  "resolve",
  "reopen",
]);

export function labFsPlugin(projectRoot: string): Plugin {
  const screensDir = path.resolve(projectRoot, "src/screens");
  const trashDir = path.resolve(projectRoot, ".lab-trash");
  // packages/design-lab -> the samantha repo root
  const feedFile = path.resolve(projectRoot, "..", "..", ...FEED_REL);

  return {
    name: "lab-fs",
    configureServer(server: ViteDevServer) {
      server.watcher.add(screensDir);
      server.watcher.on("all", (event, file) => {
        const rel = path.relative(screensDir, file);
        if (rel.startsWith("..")) return;
        if (event === "addDir" || event === "unlinkDir") {
          server.ws.send({ type: "full-reload" });
        }
      });

      server.middlewares.use("/__lab-fs", (req, res, next) => {
        if (!req.url || req.method !== "POST") {
          next();
          return;
        }
        const url = req.url.split("?")[0];
        void (async () => {
          try {
            const body = JSON.parse((await readBody(req)) || "{}") as Record<
              string,
              unknown
            >;
            if (url === "/duplicate") {
              const dir = String(body.dir ?? "");
              const src = path.join(screensDir, dir);
              if (!dir || !fs.existsSync(src)) {
                json(res, 404, { ok: false, error: "missing dir" });
                return;
              }
              const destName = uniqueDir(screensDir, dir);
              const dest = path.join(screensDir, destName);
              fs.cpSync(src, dest, { recursive: true });
              const manifest = path.join(dest, "screen.tsx");
              if (fs.existsSync(manifest)) {
                let text = fs.readFileSync(manifest, "utf8");
                text = patchExport(text, "id", destName);
                const nameMatch = text.match(
                  /export\s+const\s+name\s*=\s*["'`]([^"'`]*)["'`]/,
                );
                const name = nameMatch ? `${nameMatch[1]} copy` : `${destName}`;
                text = patchExport(text, "name", name);
                const pos = text.match(
                  /export\s+const\s+position\s*=\s*\{\s*x:\s*([-0-9.]+),\s*y:\s*([-0-9.]+)\s*\}/,
                );
                const x = pos ? Number(pos[1]) + 32 : 32;
                const y = pos ? Number(pos[2]) + 32 : 32;
                text = patchPosition(text, x, y);
                fs.writeFileSync(manifest, text);
              }
              json(res, 200, { ok: true, dir: destName });
              return;
            }
            if (url === "/delete") {
              const dir = String(body.dir ?? "");
              const src = path.join(screensDir, dir);
              if (!dir || !fs.existsSync(src)) {
                json(res, 404, { ok: false, error: "missing dir" });
                return;
              }
              fs.mkdirSync(trashDir, { recursive: true });
              const token = `${dir}__${Date.now()}`;
              fs.renameSync(src, path.join(trashDir, token));
              json(res, 200, { ok: true, token });
              return;
            }
            if (url === "/restore") {
              const token = String(body.token ?? "");
              const src = path.join(trashDir, token);
              if (!token || !fs.existsSync(src)) {
                json(res, 404, { ok: false, error: "missing token" });
                return;
              }
              const dir = token.split("__")[0] ?? token;
              let destName = dir;
              let dest = path.join(screensDir, destName);
              if (fs.existsSync(dest)) destName = uniqueDir(screensDir, dir);
              dest = path.join(screensDir, destName);
              fs.renameSync(src, dest);
              json(res, 200, { ok: true, dir: destName });
              return;
            }
            if (url === "/rename") {
              const dir = String(body.dir ?? "");
              const name = String(body.name ?? "");
              const manifest = path.join(screensDir, dir, "screen.tsx");
              if (!dir || !name || !fs.existsSync(manifest)) {
                json(res, 404, { ok: false, error: "missing manifest" });
                return;
              }
              let text = fs.readFileSync(manifest, "utf8");
              text = patchExport(text, "name", name);
              fs.writeFileSync(manifest, text);
              json(res, 200, { ok: true });
              return;
            }
            if (url === "/set-positions") {
              const positions = (body.positions ?? {}) as Positions;
              for (const [dir, pos] of Object.entries(positions)) {
                const manifest = path.join(screensDir, dir, "screen.tsx");
                if (!fs.existsSync(manifest)) continue;
                if (typeof pos?.x !== "number" || typeof pos?.y !== "number") {
                  continue;
                }
                let text = fs.readFileSync(manifest, "utf8");
                text = patchPosition(text, pos.x, pos.y);
                fs.writeFileSync(manifest, text);
              }
              json(res, 200, { ok: true });
              return;
            }
            if (url === "/notes/event") {
              const guard = req.headers[WRITE_GUARD];
              const guardValue = Array.isArray(guard) ? guard[0] : guard;
              if (guardValue !== "1") {
                json(res, 403, { ok: false, error: "forbidden" });
                return;
              }
              const t = body.t;
              if (typeof t !== "string" || !EVENT_TYPES.has(t)) {
                json(res, 400, { ok: false, error: "unknown event type" });
                return;
              }
              const at =
                typeof body.at === "string" && body.at
                  ? body.at
                  : new Date().toISOString();
              const event = stampOidOnEvent({ ...body, t, at, author: "fei" });
              fs.mkdirSync(path.dirname(feedFile), { recursive: true });
              fs.appendFileSync(feedFile, `${JSON.stringify(event)}\n`);
              json(res, 200, { ok: true });
              return;
            }
            if (url === "/notes/threads") {
              const feed = fs.existsSync(feedFile)
                ? fs.readFileSync(feedFile, "utf8")
                : "";
              json(res, 200, { ok: true, feed });
              return;
            }
            if (url === "/preview-probe") {
              const target = String(body.url ?? "");
              let parsed: URL;
              try {
                parsed = new URL(target);
              } catch {
                json(res, 400, { ok: false, reachable: false, error: "bad url" });
                return;
              }
              if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                json(res, 400, { ok: false, reachable: false, error: "only http(s)" });
                return;
              }
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(), 5000);
              try {
                const upstream = await fetch(parsed.href, {
                  method: "GET",
                  redirect: "follow",
                  signal: ac.signal,
                  headers: { accept: "text/html, */*;q=0.1" },
                });
                await upstream.body?.cancel();
                json(res, 200, {
                  ok: true,
                  reachable: true,
                  status: upstream.status,
                  xFrameOptions: upstream.headers.get("x-frame-options"),
                  csp: upstream.headers.get("content-security-policy"),
                });
              } catch (err) {
                json(res, 200, {
                  ok: true,
                  reachable: false,
                  error: err instanceof Error ? err.message : "unreachable",
                });
              } finally {
                clearTimeout(timer);
              }
              return;
            }
            json(res, 404, { ok: false, error: "unknown op" });
          } catch (err) {
            json(res, 500, {
              ok: false,
              error: err instanceof Error ? err.message : "fs error",
            });
          }
        })();
      });
    },
  };
}
