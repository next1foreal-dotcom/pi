// Detached runner: watches worker, writes .pid / .heartbeat / .log / .done.
// Never touches <id>.md (launcher is the sole .md writer).
import { runTaskWorker } from "./task-run-worker.mjs";

const [taskDir, id, cmd, ...args] = process.argv.slice(2);
if (!taskDir || !id || !cmd) {
	console.error("usage: task-runner.mjs <taskDir> <id> <cmd> [args...]");
	process.exit(2);
}

runTaskWorker({ taskDir, id, cmd, args });
