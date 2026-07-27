// Idle warm-pool slot: wait for exclusive claim, then become the task runner.
// Usage: warm-slot.mjs <poolDir> <slotId>
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTaskWorker } from "./task-run-worker.mjs";

const [poolDir, slotId] = process.argv.slice(2);
if (!poolDir || !slotId) {
	console.error("usage: warm-slot.mjs <poolDir> <slotId>");
	process.exit(2);
}

const readyPath = join(poolDir, `${slotId}.ready`);
const claimPath = join(poolDir, `${slotId}.claim`);
const claimedPath = join(poolDir, `${slotId}.claimed`);

process.env.HER_TASK_WARM_SLOT = slotId;

writeFileSync(
	readyPath,
	JSON.stringify({ slotId, pid: process.pid, readyAt: new Date().toISOString() }, null, 2),
);

const POLL_MS = 50;
const MAX_IDLE_MS = Number(process.env.HER_WARM_SLOT_MAX_IDLE_MS || 30 * 60 * 1000);
const started = Date.now();

const waitClaim = () => {
	try {
		const raw = readFileSync(claimPath, "utf8");
		const claim = JSON.parse(raw);
		if (
			typeof claim?.taskDir !== "string" ||
			typeof claim?.id !== "string" ||
			typeof claim?.file !== "string" ||
			!Array.isArray(claim?.args)
		) {
			throw new Error("malformed claim");
		}
		try {
			unlinkSync(readyPath);
		} catch {
			/* already gone */
		}
		writeFileSync(
			claimedPath,
			JSON.stringify({ slotId, pid: process.pid, taskId: claim.id, claimedAt: new Date().toISOString() }, null, 2),
		);
		try {
			unlinkSync(claimPath);
		} catch {
			/* ignore */
		}
		runTaskWorker({
			taskDir: claim.taskDir,
			id: claim.id,
			cmd: claim.file,
			args: claim.args.map(String),
			env: claim.env && typeof claim.env === "object" ? claim.env : process.env,
			heartbeatMs: typeof claim.heartbeatMs === "number" ? claim.heartbeatMs : undefined,
			cwd: typeof claim.cwd === "string" ? claim.cwd : undefined,
			stdinPath: typeof claim.stdinPath === "string" ? claim.stdinPath : undefined,
			verbatimArgs: claim.verbatimArgs === true,
		});
		return;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			if (Date.now() - started > MAX_IDLE_MS) {
				try {
					unlinkSync(readyPath);
				} catch {
					/* ignore */
				}
				process.exit(0);
			}
			setTimeout(waitClaim, POLL_MS);
			return;
		}
		try {
			unlinkSync(readyPath);
		} catch {
			/* ignore */
		}
		console.error(`warm-slot ${slotId} claim failed:`, error instanceof Error ? error.message : error);
		process.exit(1);
	}
};

waitClaim();
