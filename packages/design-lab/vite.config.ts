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
    port: 5180,
    strictPort: true,
  },
});
