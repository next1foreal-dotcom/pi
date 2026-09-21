import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, createReadStream, lstat, readFile, writeFile } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { type AcceptanceRun, acceptanceRunFilename } from "./bg-task-acceptance.ts";
import type { BgTaskRecord } from "./bg-task-record.ts";
import { tasksDir } from "./bg-task-record.ts";

const chmodAsync = promisify(chmod);
const lstatAsync = promisify(lstat);
const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);

export type TaskEvidenceSnapshot = {
	version: "task-evidence-v2";
	id: string;
	digest: string;
	created: string;
	sourceTaskId: string;
	revision: string;
	workspaceDigest: string;
	files: Array<{ path: string; status: string; digest?: string }>;
	tests: Array<{
		name: string;
		command: string[];
		exitCode: number | null;
		outputDigest: string;
		logPath: string;
	}>;
};

function git(cwd: string, args: string[]): Buffer {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "buffer",
		timeout: 10_000,
		windowsHide: true,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`cannot snapshot task evidence: git ${args.join(" ")} failed`);
	return result.stdout;
}

async function fileDigest(path: string): Promise<string | undefined> {
	const info = await lstatAsync(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (!info?.isFile()) return undefined;
	return await new Promise<string>((resolveDigest, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveDigest(hash.digest("hex")));
	});
}

async function workspaceEvidence(worktree: string) {
	const revision = git(worktree, ["rev-parse", "HEAD"]).toString("utf8").trim();
	const chunks = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
	const files: TaskEvidenceSnapshot["files"] = [];
	for (let index = 0; index < chunks.length; index++) {
		const entry = chunks[index] ?? "";
		const status = entry.slice(0, 2);
		let path = entry.slice(3);
		if (/[RC]/.test(status) && chunks[index + 1]) index += 1;
		path = path.replaceAll("\\", "/");
		const digest = await fileDigest(resolve(worktree, path));
		files.push({ path, status, ...(digest ? { digest } : {}) });
	}
	files.sort((left, right) => left.path.localeCompare(right.path));
	const workspaceDigest = createHash("sha256").update(JSON.stringify({ revision, files }), "utf8").digest("hex");
	return { revision, files, workspaceDigest };
}

function payload(snapshot: Omit<TaskEvidenceSnapshot, "version" | "id" | "digest">): string {
	return JSON.stringify({ version: "task-evidence-v2", ...snapshot });
}

async function acceptanceReceipts(memoryRoot: string, taskId: string): Promise<TaskEvidenceSnapshot["tests"]> {
	try {
		const run = JSON.parse(
			await readFileAsync(join(tasksDir(memoryRoot), acceptanceRunFilename(taskId)), "utf8"),
		) as AcceptanceRun;
		return run.gates.map((gate) => ({
			name: gate.name,
			command: gate.command,
			exitCode: gate.exitCode,
			outputDigest: gate.outputDigest,
			logPath: gate.logPath,
		}));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
async function createSnapshot(memoryRoot: string, record: BgTaskRecord): Promise<TaskEvidenceSnapshot> {
	if (record.status !== "completed") throw new Error(`task evidence requires completed parent: ${record.id}`);
	if (typeof record.worktree !== "string" || !record.worktree) {
		throw new Error(`task evidence requires an isolated worktree: ${record.id}`);
	}
	const workspace = await workspaceEvidence(record.worktree);
	const value = {
		created: record.endedAt ?? record.updated,
		sourceTaskId: record.id,
		revision: workspace.revision,
		workspaceDigest: workspace.workspaceDigest,
		files: workspace.files,
		tests: await acceptanceReceipts(memoryRoot, record.id),
	};
	const digest = createHash("sha256").update(payload(value), "utf8").digest("hex");
	return {
		version: "task-evidence-v2",
		id: `ev-${digest.slice(0, 16)}`,
		digest,
		...value,
	};
}

export function taskEvidenceSnapshotPath(memoryRoot: string, taskId: string): string {
	return join(tasksDir(memoryRoot), `${taskId}.evidence.json`);
}

function verifySnapshot(snapshot: TaskEvidenceSnapshot): void {
	const digest = createHash("sha256")
		.update(
			payload({
				created: snapshot.created,
				sourceTaskId: snapshot.sourceTaskId,
				revision: snapshot.revision,
				workspaceDigest: snapshot.workspaceDigest,
				files: snapshot.files,
				tests: snapshot.tests,
			}),
			"utf8",
		)
		.digest("hex");
	if (
		snapshot.version !== "task-evidence-v2" ||
		snapshot.digest !== digest ||
		snapshot.id !== `ev-${digest.slice(0, 16)}`
	) {
		throw new Error(`task evidence snapshot digest mismatch: ${snapshot.sourceTaskId}`);
	}
}

async function writeSnapshot(memoryRoot: string, taskId: string, snapshot: TaskEvidenceSnapshot): Promise<void> {
	const path = taskEvidenceSnapshotPath(memoryRoot, taskId);
	await writeFileAsync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o444,
	});
	await chmodAsync(path, 0o444).catch(() => {
		/* Windows may not expose POSIX mode bits; digest verification remains authoritative. */
	});
}

export async function loadOrCreateTaskEvidenceSnapshot(
	memoryRoot: string,
	record: BgTaskRecord,
): Promise<TaskEvidenceSnapshot> {
	const path = taskEvidenceSnapshotPath(memoryRoot, record.id);
	let snapshot: TaskEvidenceSnapshot;
	try {
		snapshot = JSON.parse(await readFileAsync(path, "utf8")) as TaskEvidenceSnapshot;
		verifySnapshot(snapshot);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		snapshot = await createSnapshot(memoryRoot, record);
		await writeSnapshot(memoryRoot, record.id, snapshot);
	}
	if (typeof record.worktree !== "string" || !record.worktree) throw new Error("task evidence worktree is missing");
	const current = await workspaceEvidence(record.worktree);
	if (current.workspaceDigest !== snapshot.workspaceDigest) {
		throw new Error(`task evidence snapshot is stale for ${record.id}`);
	}
	return snapshot;
}

export async function shareTaskEvidenceSnapshot(
	memoryRoot: string,
	taskId: string,
	snapshot: TaskEvidenceSnapshot,
): Promise<void> {
	await writeSnapshot(memoryRoot, taskId, snapshot);
}

export function appendTaskEvidenceSnapshot(brief: string, snapshot: TaskEvidenceSnapshot): string {
	const current = brief.trimEnd();
	if (current.includes(`READ-ONLY TASK EVIDENCE SNAPSHOT ${snapshot.id} `)) return current;
	const files = snapshot.files.length
		? snapshot.files.map((file) => `- ${file.status} ${file.path}${file.digest ? ` sha256:${file.digest}` : ""}`)
		: ["- clean worktree"];
	const tests = snapshot.tests.length
		? snapshot.tests.map((test) => `- ${test.name}: exit ${test.exitCode}; ${test.outputDigest}`)
		: ["- no acceptance receipts"];
	return [
		...(current ? [current, ""] : []),
		`READ-ONLY TASK EVIDENCE SNAPSHOT ${snapshot.id} (${snapshot.digest.slice(0, 16)}):`,
		`Source task: ${snapshot.sourceTaskId}`,
		`Revision: ${snapshot.revision}`,
		`Workspace digest: ${snapshot.workspaceDigest}`,
		"Changed files:",
		...files,
		"Acceptance receipts:",
		...tests,
	].join("\n");
}
