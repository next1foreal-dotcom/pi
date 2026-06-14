import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { Memory } from "./memory.ts";
import { checkMemoryExport, classifyMemoryCorpus } from "./privacy.ts";
import { type GateDecision, listHerTasks, type VerifyStepInput, verifyStep } from "./task.ts";

export const goldenEvalCategories = ["memory", "boundary", "multistep"] as const;
export type GoldenEvalCategory = (typeof goldenEvalCategories)[number];
export type GoldenEvalScore = 0 | 1 | 2;

interface BaseGoldenFixture {
	category: GoldenEvalCategory;
	id: string;
	title: string;
}

export interface MemoryGoldenFixture extends BaseGoldenFixture {
	category: "memory";
	expectedRefs: string[];
	forbiddenTerms?: string[];
	k?: number;
	query: string;
	requiredTerms?: string[];
}

export interface BoundaryAuthorizationFixture extends BaseGoldenFixture {
	authorization: GateDecision;
	category: "boundary";
	expectedGate?: string;
	expectedRule?: string;
	expectedVerdict: "ALLOW" | "DENY";
	mode: "authorization";
}

export interface BoundaryPrivacyExportFixture extends BaseGoldenFixture {
	category: "boundary";
	expectedAllowed: boolean;
	expectedBlockedRefs?: string[];
	mode: "privacy-export";
	refs: string[];
}

export interface BoundaryStepGateFixture extends BaseGoldenFixture {
	category: "boundary";
	expectedGate?: string;
	expectedRule?: string;
	expectedVerdict: "ALLOW" | "DENY";
	input: VerifyStepInput;
	mode: "step-gate";
}

export type BoundaryGoldenFixture =
	| BoundaryAuthorizationFixture
	| BoundaryPrivacyExportFixture
	| BoundaryStepGateFixture;

export interface MultistepGoldenFixture extends BaseGoldenFixture {
	category: "multistep";
	minSteps?: number;
	requireAllowGate?: boolean;
	requireDone?: boolean;
	requireExitCriteria?: boolean;
	requireSelfReview?: boolean;
	taskId: string;
}

export type GoldenEvalFixture = BoundaryGoldenFixture | MemoryGoldenFixture | MultistepGoldenFixture;

export interface GoldenEvalItemResult {
	category: GoldenEvalCategory;
	evidence: string[];
	id: string;
	maxScore: 2;
	score: GoldenEvalScore;
	title: string;
}

export interface GoldenEvalCategorySummary {
	category: GoldenEvalCategory;
	maxScore: number;
	score: number;
}

export interface GoldenEvalAlert {
	id?: string;
	kind: "boundary-regression" | "total-regression";
	message: string;
}

export interface GoldenEvalReport {
	alerts: GoldenEvalAlert[];
	baseline?: {
		generatedAt: string;
		maxScore: number;
		score: number;
	};
	categories: GoldenEvalCategorySummary[];
	generatedAt: string;
	maxScore: number;
	results: GoldenEvalItemResult[];
	score: number;
	status: "pass" | "fail";
}

export interface RunGoldenEvalOptions {
	now?: string;
	writeBaseline?: boolean;
	writeReport?: boolean;
}

export async function runGoldenEvals(root: string, opts: RunGoldenEvalOptions = {}): Promise<GoldenEvalReport> {
	const generatedAt = normalizeNow(opts.now);
	const fixtures = await loadGoldenFixtures(root);
	const results: GoldenEvalItemResult[] = [];
	const memory = new Memory(root);
	for (const fixture of fixtures) {
		if (fixture.category === "memory") {
			results.push(await scoreMemoryFixture(memory, fixture));
			continue;
		}
		if (fixture.category === "boundary") {
			results.push(await scoreBoundaryFixture(root, fixture));
			continue;
		}
		results.push(await scoreMultistepFixture(root, fixture));
	}

	const categories = summarizeCategories(results);
	const score = results.reduce((sum, result) => sum + result.score, 0);
	const maxScore = results.reduce((sum, result) => sum + result.maxScore, 0);
	const baseline = await readBaseline(root);
	const alerts = collectAlerts(results, score, maxScore, baseline);
	const report: GoldenEvalReport = {
		generatedAt,
		score,
		maxScore,
		categories,
		results,
		alerts,
		status: alerts.length > 0 ? "fail" : "pass",
		...(baseline ? { baseline } : {}),
	};

	if (opts.writeReport ?? true) await writeReport(root, report);
	if (opts.writeBaseline) await writeBaseline(root, report);
	return report;
}

async function loadGoldenFixtures(root: string): Promise<GoldenEvalFixture[]> {
	const dir = join(root, "evals", "golden");
	const files = await jsonFiles(dir);
	const fixtures = [];
	for (const file of files) fixtures.push(validateFixture(JSON.parse(await readFile(file, "utf8"))));
	return fixtures.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
}

async function scoreMemoryFixture(memory: Memory, fixture: MemoryGoldenFixture): Promise<GoldenEvalItemResult> {
	const hits = await memory.recall(fixture.query, { k: fixture.k ?? 5 });
	const haystack = hits.map((hit) => `${hit.id}\n${hit.path}\n${hit.text}`).join("\n\n");
	const matchedRefs = fixture.expectedRefs.filter((ref) =>
		hits.some((hit) => hit.id === ref || hit.path === ref || hit.id.includes(ref) || hit.path.includes(ref)),
	);
	const matchedTerms = (fixture.requiredTerms ?? []).filter((term) => includesFolded(haystack, term));
	const forbiddenHits = (fixture.forbiddenTerms ?? []).filter((term) => includesFolded(haystack, term));
	const evidence = [
		`query: ${fixture.query}`,
		`matched refs: ${matchedRefs.length}/${fixture.expectedRefs.length}`,
		`matched required terms: ${matchedTerms.length}/${fixture.requiredTerms?.length ?? 0}`,
		`forbidden hits: ${forbiddenHits.length}`,
	];
	const allRefs = matchedRefs.length === fixture.expectedRefs.length;
	const allTerms = matchedTerms.length === (fixture.requiredTerms?.length ?? 0);
	const clean = forbiddenHits.length === 0;
	const partial = matchedRefs.length > 0 || matchedTerms.length > 0;
	return itemResult(fixture, allRefs && allTerms && clean ? 2 : partial && clean ? 1 : 0, evidence);
}

async function scoreBoundaryFixture(root: string, fixture: BoundaryGoldenFixture): Promise<GoldenEvalItemResult> {
	if (fixture.mode === "privacy-export") {
		await classifyMemoryCorpus(root);
		const result = await checkMemoryExport(root, fixture.refs);
		const blockedRefs = result.blocked.map((record) => record.path);
		const expectedBlocked = fixture.expectedBlockedRefs ?? [];
		const allBlocked = expectedBlocked.every((ref) => blockedRefs.includes(ref));
		const verdictMatches = result.allowed === fixture.expectedAllowed;
		const evidence = [
			`allowed: ${result.allowed}`,
			`blocked: ${blockedRefs.join(", ") || "(none)"}`,
			`unknown: ${result.unknown.join(", ") || "(none)"}`,
		];
		return itemResult(fixture, verdictMatches && allBlocked ? 2 : verdictMatches ? 1 : 0, evidence);
	}
	const decision =
		fixture.mode === "authorization"
			? verifyStep({
					authorization: fixture.authorization,
					retryCount: 0,
					selfReview: "boundary fixture self-review",
					exitCriteriaResults: [{ criterion: "boundary expectation", passed: true }],
				})
			: verifyStep(fixture.input);
	const verdictMatches = decision.verdict === fixture.expectedVerdict;
	const gateMatches = !fixture.expectedGate || decision.gate === fixture.expectedGate;
	const ruleMatches = !fixture.expectedRule || decision.rule === fixture.expectedRule;
	const evidence = [`verdict: ${decision.verdict}`, `gate: ${decision.gate}`, `rule: ${decision.rule}`];
	return itemResult(fixture, verdictMatches && gateMatches && ruleMatches ? 2 : verdictMatches ? 1 : 0, evidence);
}

async function scoreMultistepFixture(root: string, fixture: MultistepGoldenFixture): Promise<GoldenEvalItemResult> {
	const task = (await listHerTasks(root)).find((item) => item.id === fixture.taskId);
	if (!task) return itemResult(fixture, 0, [`task not found: ${fixture.taskId}`]);
	const checks = [
		!fixture.requireDone || task.status === "done",
		task.steps.length >= (fixture.minSteps ?? 1),
		!fixture.requireExitCriteria || task.steps.every((step) => step.exitCriteria.length > 0),
		!fixture.requireSelfReview || task.steps.every((step) => Boolean(step.selfReview?.trim())),
		!fixture.requireAllowGate ||
			task.steps.every((step) => step.gateHistory.some((decision) => decision.verdict === "ALLOW")),
	];
	const passed = checks.filter(Boolean).length;
	const evidence = [
		`task status: ${task.status}`,
		`steps: ${task.steps.length}`,
		`checks: ${passed}/${checks.length}`,
	];
	return itemResult(fixture, passed === checks.length ? 2 : passed > 1 ? 1 : 0, evidence);
}

function itemResult(fixture: GoldenEvalFixture, score: GoldenEvalScore, evidence: string[]): GoldenEvalItemResult {
	return { id: fixture.id, title: fixture.title, category: fixture.category, score, maxScore: 2, evidence };
}

function summarizeCategories(results: GoldenEvalItemResult[]): GoldenEvalCategorySummary[] {
	return goldenEvalCategories.map((category) => {
		const items = results.filter((result) => result.category === category);
		return {
			category,
			score: items.reduce((sum, item) => sum + item.score, 0),
			maxScore: items.reduce((sum, item) => sum + item.maxScore, 0),
		};
	});
}

function collectAlerts(
	results: GoldenEvalItemResult[],
	score: number,
	maxScore: number,
	baseline?: GoldenEvalReport["baseline"],
): GoldenEvalAlert[] {
	const alerts: GoldenEvalAlert[] = [];
	for (const result of results) {
		if (result.category === "boundary" && result.score < 2) {
			alerts.push({
				kind: "boundary-regression",
				id: result.id,
				message: `boundary fixture ${result.id} scored ${result.score}/2`,
			});
		}
	}
	if (baseline && maxScore > 0 && baseline.maxScore > 0) {
		const ratio = score / maxScore;
		const baselineRatio = baseline.score / baseline.maxScore;
		if (ratio < baselineRatio * 0.9) {
			alerts.push({
				kind: "total-regression",
				message: `total score ratio ${ratio.toFixed(3)} is more than 10% below baseline ${baselineRatio.toFixed(3)}`,
			});
		}
	}
	return alerts;
}

async function readBaseline(root: string): Promise<GoldenEvalReport["baseline"] | undefined> {
	try {
		const baseline = JSON.parse(await readFile(join(root, "evals", "history", "baseline.json"), "utf8")) as {
			generatedAt?: string;
			maxScore?: number;
			score?: number;
		};
		if (
			typeof baseline.generatedAt === "string" &&
			typeof baseline.score === "number" &&
			typeof baseline.maxScore === "number"
		) {
			return baseline as GoldenEvalReport["baseline"];
		}
		return undefined;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function writeBaseline(root: string, report: GoldenEvalReport): Promise<void> {
	const payload = {
		generatedAt: report.generatedAt,
		score: report.score,
		maxScore: report.maxScore,
		categories: report.categories,
		results: report.results.map(({ id, category, score, maxScore }) => ({ id, category, score, maxScore })),
	};
	await writeJsonFile(join(root, "evals", "history", "baseline.json"), payload);
}

async function writeReport(root: string, report: GoldenEvalReport): Promise<void> {
	const safeStamp = report.generatedAt.replace(/[:.]/g, "-");
	await writeJsonFile(join(root, "evals", "history", `${safeStamp}.json`), report);
	await writeJsonFile(join(root, "evals", "history", "latest.json"), report);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function jsonFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await jsonFiles(fullPath)));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".json") && basename(fullPath) !== "baseline.json")
			files.push(fullPath);
	}
	return files.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));
}

function validateFixture(raw: unknown): GoldenEvalFixture {
	if (!raw || typeof raw !== "object") throw new Error("golden eval fixture must be an object");
	const fixture = raw as GoldenEvalFixture;
	if (!goldenEvalCategories.includes(fixture.category))
		throw new Error(`invalid golden eval category: ${fixture.category}`);
	if (!fixture.id?.trim()) throw new Error("golden eval fixture requires id");
	if (!fixture.title?.trim()) throw new Error(`golden eval fixture ${fixture.id} requires title`);
	return fixture;
}

function includesFolded(haystack: string, needle: string): boolean {
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

function normalizeNow(now: string | undefined): string {
	const date = now ? new Date(now) : new Date();
	if (Number.isNaN(date.getTime())) throw new Error(`invalid eval timestamp: ${now}`);
	return date.toISOString();
}
