/**
 * Thin launcher: exec tsx CLI against deer-workflow-runner.ts.
 * Avoids Node 24 `register()`/`--loader` deprecation conflicts with tsx 4.22.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const runnerTs = fileURLToPath(new URL("./deer-workflow-runner.ts", import.meta.url));

const child = spawn(process.execPath, [tsxCli, runnerTs], {
	stdio: "inherit",
	env: process.env,
	windowsHide: true,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
