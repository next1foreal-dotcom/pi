import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { labFsPlugin } from "./vite-plugin-lab-fs.ts";

export default defineConfig({
  plugins: [react(), labFsPlugin(process.cwd())],
  server: {
    port: 5180,
    strictPort: true,
  },
});
