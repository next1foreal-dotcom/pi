import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ImprovementCase } from "./improvement-assessment.ts";
import { disallowedTargetPaths } from "./selfmod-paths.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ExperimentCase extends ImprovementCase {
	input: JsonValue;
	expected: JsonValue;
}
export interface FrozenImprovementPlan {
	version: 1;
	proposalId: string;
	baselineCommit: string;
	targets: readonly string[];
	trainingInputDigests: readonly string[];
	cases: readonly ExperimentCase[];
	minHoldoutGain: number;
	maxTotalCostMs: number;
	priorExperimentCostMs: number;
	timeoutMs: number;
	maxOutputBytes: number;
	evaluatorSource: string;
	evaluatorDigest: string;
	suiteDigest: string;
}

const frozenPlans = new WeakSet<object>();
export const IMPROVEMENT_PLAN_DIR = "evals/selfmod-improvement";
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function canonicalJson(value: unknown, depth = 0): string {
	if (depth > 40) throw new Error("JSON nesting limit exceeded");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		const row = value as Record<string, unknown>;
		return `{${Object.keys(row)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key], depth + 1)}`)
			.join(",")}}`;
	}
	throw new Error("only finite JSON values are allowed");
}

export function isFrozenImprovementPlan(value: unknown): value is FrozenImprovementPlan {
	return !!value && typeof value === "object" && frozenPlans.has(value);
}

/** Host-owned files only. This rejects links; it is not a hostile-filesystem sandbox. */
export async function readProtectedFile(root: string, rel: string, maxBytes: number): Promise<Buffer> {
	if (
		!rel ||
		isAbsolute(rel) ||
		/[\\\x00-\x1f:]/.test(rel) ||
		rel.split("/").some((s) => !s || s === "." || s === "..")
	) {
		throw new Error("unsafe protected file path");
	}
	const base = await realpath(root);
	let path = base;
	for (const segment of rel.split("/")) {
		path = join(path, segment);
		if ((await lstat(path)).isSymbolicLink()) throw new Error("protected file symlink rejected");
	}
	const info = await lstat(path);
	if (!info.isFile() || info.size > maxBytes) throw new Error("protected file missing or oversized");
	const actual = await realpath(path);
	const fromRoot = relative(base, actual);
	if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("protected file escaped root");
	const bytes = await readFile(actual);
	if (bytes.length > maxBytes) throw new Error("protected file grew past byte limit");
	return bytes;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plan record required");
	return value as Record<string, unknown>;
}
function text(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("nonempty plan string required");
	return value;
}
function amount(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
		throw new Error("invalid plan limit");
	return value;
}
function freezeDeep<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

/** Called before apply, not from model-supplied proposal JSON. No plan => no adoption. */
export async function loadImprovementPlan(opts: {
	memoryDir: string;
	proposalId: string;
	baselineCommit: string;
	targetPaths: readonly string[];
}): Promise<FrozenImprovementPlan> {
	if (!/^[A-Za-z0-9_-]{1,100}$/.test(opts.proposalId)) throw new Error("unsafe proposal ID for evaluation");
	if (!/^[a-f0-9]{40}$/.test(opts.baselineCommit)) throw new Error("exact baseline commit required");
	const rel = `${IMPROVEMENT_PLAN_DIR}/${opts.proposalId}.json`;
	const bytes = await readProtectedFile(opts.memoryDir, rel, 1024 * 1024);
	const raw = object(JSON.parse(bytes.toString("utf8")));
	if (raw.version !== 1 || raw.proposalId !== opts.proposalId || raw.baselineCommit !== opts.baselineCommit) {
		throw new Error("evaluation plan is not bound to this proposal and baseline");
	}
	const targets = Array.isArray(raw.targets) ? raw.targets.map(text) : [];
	if (
		!targets.length ||
		targets.length > 20 ||
		new Set(targets).size !== targets.length ||
		disallowedTargetPaths(targets).length
	) {
		throw new Error("invalid evaluation targets");
	}
	if (targets.some((p) => !p.endsWith(".md") || /[\\\r\n\x00]/.test(p)))
		throw new Error("V1 evaluates Markdown skills only");
	if (canonicalJson([...targets].sort()) !== canonicalJson([...opts.targetPaths].sort()))
		throw new Error("evaluation targets differ from proposal");
	const evaluator = object(raw.evaluator);
	const evaluatorPath = text(evaluator.path);
	if (!evaluatorPath.startsWith(`${IMPROVEMENT_PLAN_DIR}/evaluators/`) || !evaluatorPath.endsWith(".mjs")) {
		throw new Error("evaluator must be in the protected evaluator directory");
	}
	const source = await readProtectedFile(opts.memoryDir, evaluatorPath, 256 * 1024);
	if (source.toString("utf8").includes("\ufffd")) throw new Error("evaluator is not valid UTF-8");
	const evaluatorDigest = sha256(source);
	if (evaluatorDigest !== evaluator.sha256) throw new Error("evaluator digest mismatch");
	if (!Array.isArray(raw.trainingInputDigests)) throw new Error("training input digest list required");
	const training = raw.trainingInputDigests.map(text);
	if (training.some((d) => !/^[a-f0-9]{64}$/.test(d))) throw new Error("invalid training input digest");
	if (!Array.isArray(raw.cases) || raw.cases.length > 100) throw new Error("invalid evaluation suite");
	const ids = new Set<string>();
	const inputs = new Set<string>(training);
	const cases: ExperimentCase[] = raw.cases.map((entry) => {
		const item = object(entry);
		const id = text(item.id);
		if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || ids.has(id)) throw new Error("invalid or duplicate case ID");
		if (item.split !== "holdout" && item.split !== "regression") throw new Error("invalid case split");
		const inputDigest = sha256(canonicalJson(item.input));
		if (inputs.has(inputDigest)) throw new Error("duplicate or training-overlapping evaluation input");
		canonicalJson(item.expected);
		ids.add(id);
		inputs.add(inputDigest);
		return {
			id,
			split: item.split,
			inputDigest,
			input: item.input as JsonValue,
			expected: item.expected as JsonValue,
		};
	});
	if (!cases.some((c) => c.split === "holdout") || !cases.some((c) => c.split === "regression")) {
		throw new Error("held-out and regression cases are both required");
	}
	const plan: FrozenImprovementPlan = {
		version: 1,
		proposalId: opts.proposalId,
		baselineCommit: opts.baselineCommit,
		targets,
		trainingInputDigests: training,
		cases,
		minHoldoutGain: amount(raw.minHoldoutGain, Number.EPSILON, 1),
		maxTotalCostMs: amount(raw.maxTotalCostMs, 1, 3_600_000),
		priorExperimentCostMs: amount(raw.priorExperimentCostMs, 0, 3_600_000),
		timeoutMs: amount(raw.timeoutMs, 1, 120_000),
		maxOutputBytes: amount(raw.maxOutputBytes, 1, 1024 * 1024),
		evaluatorSource: source.toString("utf8"),
		evaluatorDigest,
		suiteDigest: sha256(canonicalJson(raw)),
	};
	if (plan.priorExperimentCostMs >= plan.maxTotalCostMs) throw new Error("experiment budget already exhausted");
	freezeDeep(plan);
	frozenPlans.add(plan);
	return plan;
}

export function assertOutsideWorktree(path: string, worktree: string): void {
	const rel = relative(resolve(worktree), resolve(path));
	if (
		!rel ||
		(!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel))
	) {
		throw new Error("host evaluation files must be outside the candidate worktree");
	}
}
