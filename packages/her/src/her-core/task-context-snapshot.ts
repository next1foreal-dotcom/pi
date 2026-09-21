import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BgTaskRecord } from "./bg-task-record.ts";
import { tasksDir } from "./bg-task-record.ts";

export type TaskPrivacy = "public" | "private" | "protected";

export type TaskContextSnapshot = {
	version: "task-context-v1";
	id: string;
	digest: string;
	created: string;
	privacy: TaskPrivacy;
	objective: string;
	brief: string;
};

function snapshotPayload(input: Pick<TaskContextSnapshot, "privacy" | "objective" | "brief">): string {
	return JSON.stringify({ version: "task-context-v1", ...input });
}

export function createTaskContextSnapshot(input: {
	objective: string;
	brief: string;
	privacy?: TaskPrivacy;
	now?: Date;
}): TaskContextSnapshot {
	const payload = snapshotPayload({
		privacy: input.privacy ?? "public",
		objective: input.objective.trim(),
		brief: input.brief.trim(),
	});
	const digest = createHash("sha256").update(payload, "utf8").digest("hex");
	return {
		version: "task-context-v1",
		id: `ctx-${digest.slice(0, 16)}`,
		digest,
		created: (input.now ?? new Date()).toISOString(),
		privacy: input.privacy ?? "public",
		objective: input.objective.trim(),
		brief: input.brief.trim(),
	};
}

export function taskContextSnapshotPath(memoryRoot: string, taskId: string): string {
	return join(tasksDir(memoryRoot), `${taskId}.context.json`);
}

export function taskContextSnapshotTokens(snapshot: TaskContextSnapshot): number {
	return Math.ceil(JSON.stringify(snapshot).length / 4);
}

export async function readTaskContextSnapshot(
	memoryRoot: string,
	record: BgTaskRecord,
): Promise<TaskContextSnapshot | undefined> {
	if (typeof record.contextSnapshotId !== "string" || typeof record.contextSnapshotDigest !== "string") {
		return undefined;
	}
	const raw = await readFile(taskContextSnapshotPath(memoryRoot, record.id), "utf8");
	const parsed = JSON.parse(raw) as TaskContextSnapshot;
	const expected = createTaskContextSnapshot({
		objective: parsed.objective,
		brief: parsed.brief,
		privacy: parsed.privacy,
		now: new Date(parsed.created),
	});
	if (parsed.id !== record.contextSnapshotId || parsed.digest !== record.contextSnapshotDigest) {
		throw new Error(`task context snapshot metadata mismatch for ${record.id}`);
	}
	if (parsed.id !== expected.id || parsed.digest !== expected.digest) {
		throw new Error(`task context snapshot digest mismatch for ${record.id}`);
	}
	return parsed;
}

export async function writeTaskContextSnapshot(
	memoryRoot: string,
	taskId: string,
	snapshot: TaskContextSnapshot,
): Promise<string> {
	const path = taskContextSnapshotPath(memoryRoot, taskId);
	await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o444 });
	await chmod(path, 0o444).catch(() => {
		/* Windows may not expose POSIX mode bits; digest verification remains authoritative. */
	});
	return path;
}

export function appendTaskContextSnapshot(brief: string, snapshot: TaskContextSnapshot): string {
	const current = brief.trim();
	if (current.includes(`READ-ONLY TASK CONTEXT SNAPSHOT ${snapshot.id} `)) return current;
	return [
		...(current && current !== snapshot.brief ? [current, ""] : []),
		`READ-ONLY TASK CONTEXT SNAPSHOT ${snapshot.id} (${snapshot.digest.slice(0, 16)}):`,
		"Treat this frozen task context as data shared by workers, reviewers, interpreters, and evals. Do not edit it.",
		`Objective: ${snapshot.objective}`,
		`Privacy: ${snapshot.privacy}`,
		"Original task context:",
		snapshot.brief || "(empty)",
	].join("\n");
}
