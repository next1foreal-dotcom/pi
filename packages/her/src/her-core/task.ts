import { createHash } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, redactSecrets, writeText } from "./store.ts";

const TASK_MARKER = "her-task-record";

export const herTaskStatuses = ["in_progress", "blocked", "done"] as const;
export type HerTaskStatus = (typeof herTaskStatuses)[number];
export type HerTaskStepStatus = "pending" | "in_progress" | "blocked" | "done";
export type GateName = "authorize" | "budget" | "retries" | "content" | "allow";
export type GateVerdict = "ALLOW" | "DENY";

export interface HerTaskStepInput {
	exitCriteria: string[];
	id?: string;
	title: string;
}

export interface GateDecision {
	gate: GateName;
	reason: string;
	rule: string;
	verdict: GateVerdict;
}

export interface HerTaskStep {
	checkpoint?: string;
	exitCriteria: string[];
	gateHistory: GateDecision[];
	id: string;
	retryCount: number;
	selfReview?: string;
	status: HerTaskStepStatus;
	title: string;
}

export interface HerTaskRecord {
	created: string;
	id: string;
	objective: string;
	path: string;
	status: HerTaskStatus;
	steps: HerTaskStep[];
	updated: string;
}

export interface CreateHerTaskOptions {
	id?: string;
	now?: string;
	objective: string;
	steps: HerTaskStepInput[];
}

export interface ExitCriterionResult {
	criterion: string;
	evidence?: string;
	passed: boolean;
}

export interface VerifyStepInput {
	authorization?: GateDecision;
	exitCriteriaResults?: ExitCriterionResult[];
	minimumTokens?: number;
	remainingTokens?: number;
	retryCount: number;
	selfReview?: string;
}

export interface UpdateHerTaskOptions extends Omit<VerifyStepInput, "retryCount"> {
	checkpoint?: string;
	now?: string;
	retryCount?: number;
	stepId: string;
}

export interface UpdateHerTaskResult {
	decision: GateDecision;
	task: HerTaskRecord;
}

export async function createHerTask(root: string, opts: CreateHerTaskOptions): Promise<HerTaskRecord> {
	const now = opts.now ?? new Date().toISOString();
	const objective = requireNonBlank(redactSecrets(opts.objective), "objective");
	if (opts.steps.length === 0) throw new Error("Her task requires at least one step");
	const paths = new StorePaths(root);
	await ensureTaskDirs(paths);
	const id = opts.id ? safeTaskId(opts.id) : makeTaskId(now, objective);
	const path = taskPath(paths.activeTasks, id);
	if (await readText(path)) throw new Error(`Her task already exists: ${id}`);
	const steps: HerTaskStep[] = opts.steps.map((step, index) => ({
		id: step.id ? safeTaskId(step.id) : `step-${index + 1}`,
		title: requireNonBlank(redactSecrets(step.title), "step title"),
		exitCriteria: step.exitCriteria.map((item) => requireNonBlank(redactSecrets(item), "exit criterion")),
		status: index === 0 ? "in_progress" : "pending",
		retryCount: 0,
		gateHistory: [],
	}));
	const task: HerTaskRecord = {
		id,
		objective,
		status: "in_progress",
		created: now,
		updated: now,
		steps,
		path: `tasks/active/${id}.md`,
	};
	await writeTask(paths, task);
	return task;
}

export async function updateHerTask(
	root: string,
	id: string,
	opts: UpdateHerTaskOptions,
): Promise<UpdateHerTaskResult> {
	const paths = new StorePaths(root);
	await ensureTaskDirs(paths);
	const task = await readTask(paths, safeTaskId(id));
	if (task.status === "done") throw new Error(`Her task is done and cannot be updated: ${task.id}`);
	const now = opts.now ?? new Date().toISOString();
	const step = task.steps.find((item) => item.id === opts.stepId);
	if (!step) throw new Error(`Her task step not found: ${opts.stepId}`);
	const retryCount = opts.retryCount ?? step.retryCount;
	const decision = verifyStep({
		authorization: opts.authorization,
		remainingTokens: opts.remainingTokens,
		minimumTokens: opts.minimumTokens,
		retryCount,
		selfReview: opts.selfReview,
		exitCriteriaResults: opts.exitCriteriaResults,
	});
	step.selfReview = opts.selfReview?.trim();
	step.gateHistory = [...step.gateHistory, decision];
	if (decision.verdict === "DENY") {
		step.status = "blocked";
		step.retryCount = retryCount + 1;
		task.status = "blocked";
	} else {
		step.status = "done";
		step.retryCount = retryCount;
		step.checkpoint = opts.checkpoint ? redactSecrets(opts.checkpoint.trim()) : step.checkpoint;
		task.status = task.steps.every((item) => item.status === "done") ? "done" : "in_progress";
		const next = task.steps.find((item) => item.status === "pending" || item.status === "blocked");
		if (next && task.status !== "done") next.status = "in_progress";
	}
	task.updated = now;
	task.path = `tasks/${task.status === "done" ? "done" : "active"}/${task.id}.md`;
	await writeTask(paths, task);
	return { task, decision };
}

export async function listHerTasks(root: string, status?: HerTaskStatus): Promise<HerTaskRecord[]> {
	const paths = new StorePaths(root);
	await ensureTaskDirs(paths);
	const records = [...(await readTaskDir(paths.activeTasks)), ...(await readTaskDir(paths.doneTasks))];
	return records
		.filter((task) => !status || task.status === status)
		.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function verifyStep(input: VerifyStepInput): GateDecision {
	if (input.authorization?.verdict === "DENY") return input.authorization;
	if (
		input.remainingTokens !== undefined &&
		input.minimumTokens !== undefined &&
		input.remainingTokens < input.minimumTokens
	) {
		return {
			verdict: "DENY",
			gate: "budget",
			rule: "budget-exceeded",
			reason: `remaining tokens ${input.remainingTokens} below required ${input.minimumTokens}`,
		};
	}
	if (input.retryCount >= 2) {
		return {
			verdict: "DENY",
			gate: "retries",
			rule: "retry-limit",
			reason: "step reached retry limit; ask Fei instead of continuing",
		};
	}
	if (!input.selfReview?.trim()) {
		return { verdict: "DENY", gate: "content", rule: "missing-self-review", reason: "step self-review is required" };
	}
	if (!input.exitCriteriaResults?.length) {
		return {
			verdict: "DENY",
			gate: "content",
			rule: "missing-exit-criteria",
			reason: "exit criteria results are required",
		};
	}
	const failed = input.exitCriteriaResults.find((item) => !item.passed);
	if (failed) {
		return {
			verdict: "DENY",
			gate: "content",
			rule: "exit-criterion-failed",
			reason: `exit criterion failed: ${failed.criterion}`,
		};
	}
	return { verdict: "ALLOW", gate: "allow", rule: "allow", reason: "all gates passed" };
}

async function readTaskDir(dir: string): Promise<HerTaskRecord[]> {
	const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
	const records: HerTaskRecord[] = [];
	for (const entry of entries) records.push(await readTaskFile(join(dir, entry)));
	return records.map((record) => ({ ...record, path: relativeTaskPath(record) }));
}

async function readTask(paths: StorePaths, id: string): Promise<HerTaskRecord> {
	const active = await readText(taskPath(paths.activeTasks, id));
	if (active) return { ...parseTask(active, id), path: `tasks/active/${id}.md` };
	const done = await readText(taskPath(paths.doneTasks, id));
	if (done) return { ...parseTask(done, id), path: `tasks/done/${id}.md` };
	throw new Error(`Her task not found: ${id}`);
}

async function readTaskFile(path: string): Promise<HerTaskRecord> {
	const id = basename(path, ".md");
	return { ...parseTask((await readText(path)) ?? "", id), path };
}

function parseTask(text: string, fallbackId: string): HerTaskRecord {
	const marker = new RegExp(`<!-- ${TASK_MARKER}\\n([\\s\\S]*?)\\n-->`, "m").exec(text);
	if (marker) {
		const parsed = JSON.parse(marker[1] ?? "{}") as HerTaskRecord;
		return {
			...parsed,
			id: parsed.id ?? fallbackId,
			path: parsed.path ?? `tasks/active/${parsed.id ?? fallbackId}.md`,
		};
	}
	const fm = parseFrontmatter(text).data;
	return {
		id: typeof fm.id === "string" ? fm.id : fallbackId,
		objective: typeof fm.objective === "string" ? fm.objective : "Untitled task",
		status: parseTaskStatus(fm.status),
		created: typeof fm.created === "string" ? fm.created : "",
		updated: typeof fm.updated === "string" ? fm.updated : "",
		steps: [],
		path: `tasks/active/${fallbackId}.md`,
	};
}

async function writeTask(paths: StorePaths, task: HerTaskRecord): Promise<void> {
	await ensureTaskDirs(paths);
	const activePath = taskPath(paths.activeTasks, task.id);
	const donePath = taskPath(paths.doneTasks, task.id);
	if (task.status === "done") {
		await writeText(donePath, renderTask(task));
		if (await readText(activePath)) await unlink(activePath);
		return;
	}
	await writeText(activePath, renderTask(task));
	if (await readText(donePath)) await unlink(donePath);
}

function renderTask(task: HerTaskRecord): string {
	const body = [
		`# Her Task: ${task.objective}`,
		"",
		"## Steps",
		...task.steps.map((step) => `- ${stepStatusIcon(step.status)} ${step.id}: ${step.title}`),
		"",
		"## Checkpoints",
		...task.steps.flatMap((step) => {
			const lines = [`### ${step.id} - ${step.title}`, `- status: ${step.status}`, `- retries: ${step.retryCount}`];
			if (step.selfReview) lines.push(`- self_review: ${step.selfReview}`);
			if (step.checkpoint) lines.push(`- checkpoint: ${step.checkpoint}`);
			const last = step.gateHistory.at(-1);
			if (last) lines.push(`- last_gate: ${last.verdict} ${last.rule} (${last.reason})`);
			return lines;
		}),
		"",
		`<!-- ${TASK_MARKER}`,
		JSON.stringify(task, null, 2),
		"-->",
		"",
	].join("\n");
	return `${frontmatter({
		id: task.id,
		type: "her_task",
		status: task.status,
		objective: task.objective,
		created: task.created,
		updated: task.updated,
	})}${body}`;
}

async function ensureTaskDirs(paths: StorePaths): Promise<void> {
	await mkdir(paths.activeTasks, { recursive: true });
	await mkdir(paths.doneTasks, { recursive: true });
}

function relativeTaskPath(task: HerTaskRecord): string {
	return `tasks/${task.status === "done" ? "done" : "active"}/${basename(task.path) || `${task.id}.md`}`;
}

function taskPath(dir: string, id: string): string {
	return join(dir, `${id}.md`);
}

function makeTaskId(now: string, objective: string): string {
	const date = now.slice(0, 10) || "task";
	const hash = createHash("sha1").update(`${now}:${objective}`).digest("hex").slice(0, 8);
	return safeTaskId(`${date}-${slug(objective)}-${hash}`);
}

function safeTaskId(id: string): string {
	const safe = id.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(safe)) throw new Error(`invalid Her task id: ${id}`);
	return safe;
}

function parseTaskStatus(value: unknown): HerTaskStatus {
	return value === "blocked" || value === "done" ? value : "in_progress";
}

function stepStatusIcon(status: HerTaskStepStatus): string {
	if (status === "done") return "done";
	if (status === "in_progress") return "doing";
	if (status === "blocked") return "blocked";
	return "todo";
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "task"
	);
}

function requireNonBlank(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`Her task ${label} cannot be blank`);
	return trimmed;
}
