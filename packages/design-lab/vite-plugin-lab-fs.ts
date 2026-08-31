import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

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

export function labFsPlugin(projectRoot: string): Plugin {
  const screensDir = path.resolve(projectRoot, "src/screens");
  const trashDir = path.resolve(projectRoot, ".lab-trash");

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
