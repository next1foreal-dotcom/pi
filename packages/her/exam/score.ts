import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type ExecutionStatus = "COMPLETED" | "TIMEOUT" | "SPAWN_ERROR" | "GRADER_ERROR" | "ENV_FAIL" | "SKIPPED";
export type Grade = "PASS" | "PARTIAL" | "FAIL" | "UNGRADED";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ToolCallsCheck = { kind: "tool_calls"; require: Record<string, number> };
export type JsonIdsCheck = { kind: "json_ids"; file: string; field: string | null; arrayField?: string; pattern: string; expectRange: [number, number]; unique?: boolean };
export type JsonMapCheck = { kind: "json_map"; file: string; keyField?: string; valueField?: string; expect: Record<string, string>; mode?: "object" | "subset"; coerce?: "string"; valueMatch?: "contains"; keyNormalize?: "lower" };
export type JsonSetCheck = { kind: "json_set"; file: string; field: string; expect: string[]; exact: boolean; partialCredit?: boolean };
export type JsonRowsCheck = { kind: "json_rows"; file: string; exactCount?: number; minCount?: number; requiredFields?: string[]; nonEmptyFields?: string[] };
export type JsonWhereCheck = { kind: "json_where"; file: string; where: Record<string, string>; expect: Record<string, string>; valueMatch?: "contains" };
export type JsonSectionsCheck = { kind: "json_sections"; file: string; minSections: number; factsMustInclude: string[]; eachFactInSomeSection: boolean };
export type FileAbsentCheck = { kind: "file_absent"; file: string };
export type ExamCheck = ToolCallsCheck | JsonIdsCheck | JsonMapCheck | JsonSetCheck | JsonRowsCheck | JsonWhereCheck | JsonSectionsCheck | FileAbsentCheck;

export type PartialRule = { check: number; passAt: number; partialAt: number };
export type ExamTask = {
	id: string;
	category: "scrape" | "recon" | "diff" | "flow" | "dynamic" | "qa" | "docs";
	title: string;
	prompt: string;
	fixture?: string;
	network?: boolean;
	timeoutMs?: number;
	deliverables: string[];
	checks: ExamCheck[];
	fixture_notes?: string;
	partialRule?: PartialRule;
};

export type ExamCatalog = { version: number; toolPolicy: { allow: string[]; rationale?: string }; scoring: { taskPoints: Record<string, number | null>; note?: string }; tasks: ExamTask[] };
export type CheckResult = { kind: string; earned: number; possible: number; ok: boolean; detail: string; evidence?: string; hits?: number };
export type ToolCallSummary = { counts: Record<string, number>; order: string[] };
export type TaskResult = { taskId: string; executionStatus: ExecutionStatus; grade: Grade; points: number | null; checks: CheckResult[]; toolCalls: Record<string, number>; wallMs: number; artifacts: string[]; notes?: string };

const CATEGORIES = new Set<ExamTask["category"]>(["scrape", "recon", "diff", "flow", "dynamic", "qa", "docs"]);
const REQUIRED_TOOLS = ["browser_navigate", "browser_read_page", "browser_act", "write"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`tasks.json field ${field} must be an object`);
	return value;
}

function expectString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`tasks.json field ${field} must be a non-empty string`);
	return value;
}

function validateTask(value: unknown, index: number): asserts value is ExamTask {
	const task = expectRecord(value, `tasks[${index}]`);
	expectString(task.id, `tasks[${index}].id`);
	const category = expectString(task.category, `tasks[${index}].category`);
	if (!CATEGORIES.has(category as ExamTask["category"])) throw new Error(`tasks.json field tasks[${index}].category is invalid`);
	expectString(task.title, `tasks[${index}].title`);
	expectString(task.prompt, `tasks[${index}].prompt`);
	if (!Array.isArray(task.deliverables) || task.deliverables.length === 0 || task.deliverables.some((item) => typeof item !== "string" || !item)) {
		throw new Error(`tasks.json field tasks[${index}].deliverables must be non-empty`);
	}
	if (!Array.isArray(task.checks) || task.checks.length === 0 || task.checks.some((item) => !isRecord(item) || typeof item.kind !== "string")) {
		throw new Error(`tasks.json field tasks[${index}].checks must be non-empty`);
	}
}

export function parseCatalog(value: unknown): ExamCatalog {
	const catalog = expectRecord(value, "root");
	if (typeof catalog.version !== "number") throw new Error("tasks.json field version must be a number");
	const policy = expectRecord(catalog.toolPolicy, "toolPolicy");
	if (!Array.isArray(policy.allow) || policy.allow.some((tool) => typeof tool !== "string")) throw new Error("tasks.json field toolPolicy.allow must be a string array");
	const allowedTools = policy.allow as string[];
	if (allowedTools.length !== REQUIRED_TOOLS.length || REQUIRED_TOOLS.some((tool, index) => allowedTools[index] !== tool)) {
		throw new Error("tasks.json field toolPolicy.allow must contain the four exam tools in order");
	}
	const scoring = expectRecord(catalog.scoring, "scoring");
	if (!isRecord(scoring.taskPoints)) throw new Error("tasks.json field scoring.taskPoints must be an object");
	if (!Array.isArray(catalog.tasks)) throw new Error("tasks.json field tasks must be an array");
	for (const [index, task] of catalog.tasks.entries()) validateTask(task, index);
	const tasks = catalog.tasks as ExamTask[];
	if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("tasks.json field tasks contains duplicate id");
	return { version: catalog.version, toolPolicy: policy as ExamCatalog["toolPolicy"], scoring: scoring as ExamCatalog["scoring"], tasks };
}

export async function loadTasks(pathOrValue: string | unknown): Promise<ExamCatalog> {
	if (typeof pathOrValue !== "string") return parseCatalog(pathOrValue);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(pathOrValue, "utf8"));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`tasks.json cannot be read or parsed: ${detail}`);
	}
	return parseCatalog(parsed);
}

async function readJsonArtifact(outDir: string, file: string): Promise<{ value?: unknown; error?: string; path: string }> {
	const path = resolve(outDir, file);
	if (!path.startsWith(`${resolve(outDir)}\\`) && path !== resolve(outDir)) return { error: "artifact path escapes output directory", path };
	if (!existsSync(path)) return { error: "artifact file is missing", path };
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		return { error: `artifact cannot be read: ${error instanceof Error ? error.message : String(error)}`, path };
	}
	try {
		return { value: JSON.parse(content), path };
	} catch (error) {
		return { error: `artifact has invalid JSON: ${error instanceof Error ? error.message : String(error)}`, path };
	}
}

function failure(kind: string, detail: string, evidence?: string): CheckResult {
	return { kind, earned: 0, possible: 1, ok: false, detail, ...(evidence ? { evidence } : {}) };
}

function scalarMatch(actual: unknown, expected: string, contains: boolean, coerce = false): boolean {
	const value = typeof actual === "string" ? actual : coerce && (typeof actual === "number" || typeof actual === "boolean") ? String(actual) : "";
	return contains ? value.includes(expected) : value === expected;
}

async function jsonCheck<T extends ExamCheck>(check: T, outDir: string): Promise<{ value?: unknown; failure?: CheckResult; path: string }> {
	const read = await readJsonArtifact(outDir, "file" in check ? check.file : "");
	if (read.error) return { path: read.path, failure: failure(check.kind, read.error, read.path) };
	return { value: read.value, path: read.path };
}

async function scoreCheck(check: ExamCheck, outDir: string, calls: ToolCallSummary): Promise<CheckResult> {
	if (check.kind === "tool_calls") {
		const missing = Object.entries(check.require).filter(([name, count]) => (calls.counts[name] ?? 0) < count);
		return missing.length === 0
			? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "required tool calls observed" }
			: failure(check.kind, `missing required tool calls: ${missing.map(([name, count]) => `${name}:${count}`).join(", ")}`);
	}
	if (check.kind === "file_absent") {
		const path = resolve(outDir, check.file);
		return existsSync(path) ? failure(check.kind, "artifact must be absent", path) : { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "artifact is absent", evidence: path };
	}
	const artifact = await jsonCheck(check, outDir);
	if (artifact.failure) return artifact.failure;
	const value = artifact.value;
	if (check.kind === "json_ids") {
		const source = check.arrayField ? (isRecord(value) ? value[check.arrayField] : undefined) : value;
		if (!Array.isArray(source)) return failure(check.kind, "artifact has wrong top-level type: expected array", artifact.path);
		const regex = new RegExp(check.pattern);
		const numbers: number[] = [];
		for (const row of source) {
			const candidate = check.field === null ? row : isRecord(row) ? row[check.field] : undefined;
			if (typeof candidate !== "string") return failure(check.kind, "artifact item has wrong field type", artifact.path);
			const match = regex.exec(candidate);
			if (!match?.[1]) return failure(check.kind, `identifier does not match pattern: ${candidate}`, artifact.path);
			numbers.push(Number(match[1]));
		}
		const expected = Array.from({ length: check.expectRange[1] - check.expectRange[0] + 1 }, (_, index) => index + check.expectRange[0]);
		const actualSet = new Set(numbers);
		const exact = expected.every((id) => actualSet.has(id)) && actualSet.size === expected.length && numbers.length === expected.length;
		const unique = !check.unique || actualSet.size === numbers.length;
		return exact && unique ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "exact identifier coverage" } : failure(check.kind, "identifier coverage is not exact and unique", artifact.path);
	}
	if (check.kind === "json_map") {
		const objectMode = check.mode === "object";
		if (objectMode) {
			if (!isRecord(value)) return failure(check.kind, "artifact has wrong top-level type: expected object", artifact.path);
			const passed = Object.entries(check.expect).every(([key, expected]) => {
				const actualKey = check.keyNormalize === "lower" ? Object.keys(value).find((candidate) => candidate.toLowerCase() === key.toLowerCase()) : key;
				const actual = actualKey ? value[actualKey] : undefined;
				return scalarMatch(actual, expected, check.valueMatch === "contains", check.coerce === "string");
			});
			return passed ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "expected object mapping matched" } : failure(check.kind, "object mapping does not match expected values", artifact.path);
		}
		if (!Array.isArray(value)) return failure(check.kind, "artifact has wrong top-level type: expected array", artifact.path);
		const matched = Object.entries(check.expect).every(([expectedKey, expectedValue]) => value.some((row) => {
			if (!isRecord(row) || !check.keyField || !check.valueField) return false;
			const actualKey = row[check.keyField];
			const key = typeof actualKey === "string" && check.keyNormalize === "lower" ? actualKey.toLowerCase() : actualKey;
			const wanted = check.keyNormalize === "lower" ? expectedKey.toLowerCase() : expectedKey;
			return key === wanted && scalarMatch(row[check.valueField], expectedValue, check.valueMatch === "contains", check.coerce === "string");
		}));
		return matched ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "expected row mappings matched" } : failure(check.kind, "row mapping does not match expected values", artifact.path);
	}
	if (check.kind === "json_set") {
		if (!isRecord(value) || !Array.isArray(value[check.field])) return failure(check.kind, "artifact has wrong field type: expected array", artifact.path);
		const values = (value[check.field] as unknown[]).filter((item): item is string => typeof item === "string");
		const actual = new Set(values);
		const expected = new Set(check.expect);
		const hits = check.expect.filter((item) => actual.has(item)).length;
		const exact = hits === expected.size && actual.size === expected.size && values.length === expected.size;
		if (check.exact) return exact ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "exact set matched", hits } : failure(check.kind, "set is missing, duplicated, or has extra values", artifact.path);
		const earned = check.partialCredit ? hits / expected.size : hits === expected.size ? 1 : 0;
		return { kind: check.kind, earned, possible: 1, ok: earned === 1, detail: `${hits}/${expected.size} expected values found`, evidence: artifact.path, hits };
	}
	if (check.kind === "json_rows") {
		if (!Array.isArray(value)) return failure(check.kind, "artifact has wrong top-level type: expected array", artifact.path);
		if (check.exactCount !== undefined && value.length !== check.exactCount) return failure(check.kind, `row count ${value.length} is not ${check.exactCount}`, artifact.path);
		if (check.minCount !== undefined && value.length < check.minCount) return failure(check.kind, `row count ${value.length} is below ${check.minCount}`, artifact.path);
		for (const row of value) {
			if (!isRecord(row)) return failure(check.kind, "artifact row has wrong type", artifact.path);
			for (const field of check.requiredFields ?? []) if (!(field in row)) return failure(check.kind, `required field missing: ${field}`, artifact.path);
			for (const field of check.nonEmptyFields ?? []) {
				const cell = row[field];
				if ((typeof cell === "string" && cell.length === 0) || (Array.isArray(cell) && cell.length === 0) || cell === null || cell === undefined) return failure(check.kind, `non-empty field is empty: ${field}`, artifact.path);
			}
		}
		return { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "row constraints matched", evidence: artifact.path };
	}
	if (check.kind === "json_where") {
		if (!Array.isArray(value)) return failure(check.kind, "artifact has wrong top-level type: expected array", artifact.path);
		const selected = value.filter((row) => isRecord(row) && Object.entries(check.where).every(([key, expected]) => scalarMatch(row[key], expected, false)));
		const ok = selected.length > 0 && selected.some((row) => isRecord(row) && Object.entries(check.expect).every(([key, expected]) => scalarMatch(row[key], expected, check.valueMatch === "contains")));
		return ok ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "selected rows matched", evidence: artifact.path } : failure(check.kind, "selected rows do not match expected values", artifact.path);
	}
	if (check.kind === "json_sections") {
		if (!isRecord(value) || !Array.isArray(value.sections)) return failure(check.kind, "artifact has wrong top-level type: expected sections object", artifact.path);
		const sections = value.sections.filter(isRecord);
		if (sections.length < check.minSections) return failure(check.kind, `section count is below ${check.minSections}`, artifact.path);
		const allFacts = sections.flatMap((section) => Array.isArray(section.facts) ? section.facts.filter((fact): fact is string => typeof fact === "string") : []);
		const ok = check.factsMustInclude.every((fact) => allFacts.some((candidate) => candidate.includes(fact)));
		return ok ? { kind: check.kind, earned: 1, possible: 1, ok: true, detail: "facts are assigned to sections", evidence: artifact.path } : failure(check.kind, "required facts are absent from section facts", artifact.path);
	}
	throw new Error("unreachable check kind");
}

export async function scoreTask(task: ExamTask, outDir: string, toolCalls: ToolCallSummary, executionStatus: ExecutionStatus = "COMPLETED", wallMs = 0): Promise<TaskResult> {
	const checks = await Promise.all(task.checks.map((check) => scoreCheck(check, outDir, toolCalls)));
	if (task.partialRule) {
		const check = checks[task.partialRule.check];
		if (check) {
			const hits = check.hits ?? 0;
			check.earned = hits >= task.partialRule.passAt ? check.possible : hits >= task.partialRule.partialAt ? check.possible / 2 : 0;
			check.ok = check.earned === check.possible;
		}
	}
	const toolFailed = task.checks.some((check, index) => check.kind === "tool_calls" && !checks[index]?.ok);
	const earned = checks.reduce((sum, check) => sum + check.earned, 0);
	const possible = checks.reduce((sum, check) => sum + check.possible, 0);
	let grade: Grade = toolFailed ? "FAIL" : earned === possible ? "PASS" : earned > 0 ? "PARTIAL" : "FAIL";
	let points: number | null = grade === "PASS" ? 1 : grade === "PARTIAL" ? 0.5 : 0;
	if (executionStatus !== "COMPLETED") {
		grade = "UNGRADED";
		points = executionStatus === "ENV_FAIL" || executionStatus === "SKIPPED" ? null : 0;
	}
	return { taskId: task.id, executionStatus, grade, points, checks, toolCalls: toolCalls.counts, wallMs, artifacts: task.deliverables.map((file) => resolve(outDir, file)) };
}

export function summarizeScores(results: Pick<TaskResult, "points">[]): { numerator: number; denominator: number; excluded: number; score: number | null } {
	const included = results.filter((result) => result.points !== null);
	const numerator = included.reduce((sum, result) => sum + (result.points ?? 0), 0);
	return { numerator, denominator: included.length, excluded: results.length - included.length, score: included.length === 0 ? null : numerator / included.length };
}
