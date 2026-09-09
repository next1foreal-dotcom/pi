import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { labFsPlugin } from "./vite-plugin-lab-fs.ts";

/**
 * This package's own directory — NOT `process.cwd()`.
 *
 * The launcher's working directory is wherever vite was started from, which is
 * not this package: the preview runner starts it from `D:\@Her`. Every path the
 * lab-fs plugin builds hangs off this one, so with cwd the screens directory
 * pointed at a folder that does not exist and the feedback feed was written to
 * `D:\design\canvas\feed.jsonl` — outside the repo, where her tools can never
 * read it. Nothing errored; the loop was simply, silently, not connected.
 */
const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), labFsPlugin(packageRoot)],
  server: {
    // 5180 until 2026-09-09, when a real bind returned EACCES: this machine has a
    // Windows excluded TCP range 5141-5240 and nothing can ever listen inside it.
    // `design_lab_open` starts the lab with `npm run dev`, so this line — not the
    // launcher's flag — is the port she gets, and she got one that cannot exist.
    // HER_LAB_PORT is the same variable her tools read; one place moves both.
    port: Number(process.env.HER_LAB_PORT) || 5280,
    strictPort: true,
  },
});
