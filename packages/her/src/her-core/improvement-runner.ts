import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { assessImprovement, type ImprovementAssessment, type ImprovementPlan } from "./improvement-assessment.ts";
import {
	assertOutsideWorktree,
	canonicalJson,
	type FrozenImprovementPlan,
	isFrozenImprovementPlan,
	readProtectedFile,
	sha256,
} from "./improvement-plan.ts";
import { runEvaluationProcess } from "./improvement-process.ts";
import { disallowedTargetPaths } from "./selfmod-paths.ts";

const execFileAsync = promisify(execFile);
const measuredRuns = new WeakSet<object>();
export type RevisionSnapshot = { revision: string; files: Array<{ path: string; content: string }>; digest: string };
export interface ImprovementRun {
	assessment: ImprovementAssessment;
	auditDir: string;
	reportDigest: string;
	baselineCommit: string;
	candidateCommit: string;
}
type FileEvidence = { path: string; digest: string };
type Trial = { outcome: "pass" | "fail"; cost: number; evidenceDigest: string };

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["--no-optional-locks", "-C", repoRoot, ...args], {
		// Read with the same Git config as apply/checkout (notably Windows CRLF filters).
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		shell: false,
		timeout: 15_000,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	return result.stdout;
}

export async function readExactHead(repoRoot: string): Promise<string> {
	const value = (await git(repoRoot, "rev-parse", "--verify", "HEAD^{commit}")).trim();
	if (!/^[a-f0-9]{40}$/.test(value)) throw new Error("exact Git commit required");
	return value;
}

export async function readRevisionSnapshot(
	repoRoot: string,
	revision: string,
	paths: readonly string[],
): Promise<RevisionSnapshot> {
	if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("ambiguous revision rejected");
	if (disallowedTargetPaths([...paths]).length || !paths.length)
		throw new Error("snapshot target outside skill allowlist");
	const files: RevisionSnapshot["files"] = [];
	for (const path of [...paths].sort()) {
		const tree = await git(repoRoot, "ls-tree", "-z", revision, "--", path);
		const entry = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(tree);
		if (!entry || entry[3] !== path)
			throw new Error("snapshot requires a regular tracked file, not a link or directory");
		const size = Number((await git(repoRoot, "cat-file", "-s", entry[2])).trim());
		if (!Number.isSafeInteger(size) || size < 1 || size > 256 * 1024) throw new Error("snapshot file size rejected");
		const content = await git(repoRoot, "cat-file", "blob", entry[2]);
		if (Buffer.byteLength(content) !== size || content.includes("\ufffd"))
			throw new Error("snapshot is not valid UTF-8");
		files.push({ path, content });
	}
	return { revision, files, digest: sha256(canonicalJson(files)) };
}

async function writeArtifact(root: string, path: string, bytes: string, evidence: FileEvidence[]): Promise<void> {
	await writeFile(join(root, path), bytes, { flag: "wx", mode: 0o600 });
	evidence.push({ path, digest: sha256(bytes) });
}

/** Artifact integrity check against the trusted caller's receipt, not self-reported hashes. */
export async function verifyImprovementRun(run: ImprovementRun): Promise<boolean> {
	try {
		const reportBytes = await readProtectedFile(run.auditDir, "report.json", 4 * 1024 * 1024);
		if (sha256(reportBytes) !== run.reportDigest) return false;
		const report = JSON.parse(reportBytes.toString("utf8")) as { files: FileEvidence[] };
		if (!Array.isArray(report.files) || !report.files.length) return false;
		for (const file of report.files) {
			if (sha256(await readProtectedFile(run.auditDir, file.path, 4 * 1024 * 1024)) !== file.digest) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Runs exact revision bytes through a frozen, host-owned evaluator.
 * The evaluator returns OBSERVATIONS. The parent compares those with withheld expected
 * observations. The candidate never receives the answers, manifest, or budget.
 * This is deterministic paired evaluation, not a significance test or capability claim.
 */
export async function runImprovementExperiment(opts: {
	plan: FrozenImprovementPlan;
	worktreePath: string;
	auditRoot: string;
	signal?: AbortSignal;
}): Promise<ImprovementRun> {
	if (!isFrozenImprovementPlan(opts.plan)) throw new Error("host-frozen plan required");
	if (opts.signal?.aborted) throw new Error("evaluation aborted");
	const started = performance.now();
	const plan = opts.plan;
	const worktree = await realpath(opts.worktreePath);
	assertOutsideWorktree(opts.auditRoot, worktree);
	await mkdir(opts.auditRoot, { recursive: true, mode: 0o700 });
	const auditRoot = await realpath(opts.auditRoot);
	assertOutsideWorktree(auditRoot, worktree);
	const auditDir = await mkdtemp(join(auditRoot, "experiment-"));
	await chmod(auditDir, 0o700);
	const files: FileEvidence[] = [];
	const candidateCommit = await readExactHead(worktree);
	const changed = (await git(worktree, "diff", "--name-only", "-z", plan.baselineCommit, candidateCommit, "--"))
		.split("\0")
		.filter(Boolean);
	if (!changed.length || disallowedTargetPaths(changed).length || changed.some((p) => !plan.targets.includes(p))) {
		throw new Error("candidate changed unplanned or protected files, or has no changes");
	}
	if ((await git(worktree, "status", "--porcelain", "--untracked-files=no")).trim())
		throw new Error("candidate has uncommitted tracked changes");
	const baseline = await readRevisionSnapshot(worktree, plan.baselineCommit, plan.targets);
	const candidate = await readRevisionSnapshot(worktree, candidateCommit, plan.targets);
	await writeArtifact(auditDir, "suite.json", canonicalJson(plan), files);
	await writeArtifact(auditDir, "evaluator.mjs", plan.evaluatorSource, files);
	await writeArtifact(auditDir, "baseline.json", canonicalJson(baseline), files);
	await writeArtifact(auditDir, "candidate.json", canonicalJson(candidate), files);
	const paired: Array<{ id: string; inputDigest: string; baseline: Trial; candidate: Trial }> = [];
	const errors: string[] = [];
	for (const [index, item] of plan.cases.entries()) {
		try {
			const before = await trial("baseline", baseline, index, item, opts, auditDir, started, files);
			const after = await trial("candidate", candidate, index, item, opts, auditDir, started, files);
			paired.push({ id: item.id, inputDigest: item.inputDigest, baseline: before, candidate: after });
		} catch (error) {
			errors.push(error instanceof Error ? error.message : "evaluation failed");
			break;
		}
	}
	const binding: ImprovementPlan = {
		version: 1,
		proposalId: plan.proposalId,
		baselineDigest: baseline.digest,
		candidateDigest: candidate.digest,
		suiteDigest: plan.suiteDigest,
		evaluatorDigest: plan.evaluatorDigest,
		trainingInputDigests: [...plan.trainingInputDigests],
		cases: plan.cases.map(({ id, split, inputDigest }) => ({ id, split, inputDigest })),
		minHoldoutGain: plan.minHoldoutGain,
		maxTotalCost: plan.maxTotalCostMs,
	};
	const trialCost = paired.reduce((sum, pair) => sum + pair.baseline.cost + pair.candidate.cost, 0);
	const overheadCost = plan.priorExperimentCostMs + Math.max(0, performance.now() - started - trialCost);
	let assessment = assessImprovement(binding, { ...binding, cases: paired, overheadCost });
	if (errors.length) assessment = { status: "needs-evidence", reasons: errors };
	if ((await readExactHead(worktree)) !== candidateCommit)
		assessment = { status: "needs-evidence", reasons: ["candidate revision changed during evaluation"] };
	const report = canonicalJson({
		version: 1,
		binding,
		evidence: { ...binding, cases: paired, overheadCost },
		assessment,
		baselineCommit: plan.baselineCommit,
		candidateCommit,
		files,
		costUnit: "elapsed-ms",
		priorCostSource: "trusted-host-plan",
	});
	await writeFile(join(auditDir, "report.json"), report, { flag: "wx", mode: 0o600 });
	const run: ImprovementRun = {
		assessment,
		auditDir,
		reportDigest: sha256(report),
		baselineCommit: plan.baselineCommit,
		candidateCommit,
	};
	if (!(await verifyImprovementRun(run))) throw new Error("evaluation artifact integrity failed");
	Object.freeze(run.assessment.reasons);
	Object.freeze(run.assessment);
	Object.freeze(run);
	measuredRuns.add(run);
	return run;
}

async function trial(
	side: string,
	snapshot: RevisionSnapshot,
	index: number,
	item: FrozenImprovementPlan["cases"][number],
	opts: { plan: FrozenImprovementPlan; signal?: AbortSignal },
	auditDir: string,
	started: number,
	files: FileEvidence[],
): Promise<Trial> {
	const remaining = opts.plan.maxTotalCostMs - opts.plan.priorExperimentCostMs - (performance.now() - started);
	if (remaining <= 0) throw new Error("experiment budget exhausted");
	const request = canonicalJson({ version: 1, artifacts: snapshot.files, input: item.input });
	const result = await runEvaluationProcess({
		evaluatorFile: join(auditDir, "evaluator.mjs"),
		request,
		timeoutMs: Math.min(opts.plan.timeoutMs, remaining),
		maxOutputBytes: opts.plan.maxOutputBytes,
		signal: opts.signal,
	});
	const prefix = `${index}-${side}`;
	await writeArtifact(auditDir, `${prefix}.stdout`, result.stdout, files);
	await writeArtifact(auditDir, `${prefix}.stderr`, result.stderr, files);
	await writeArtifact(auditDir, `${prefix}.process.json`, canonicalJson(result), files);
	if (result.error || result.exitCode !== 0) throw new Error(result.error ?? "evaluation process failed");
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("evaluator did not return one JSON observation");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("observation" in parsed))
		throw new Error("evaluator observation missing");
	const observation = (parsed as { observation: unknown }).observation;
	const outcome = canonicalJson(observation) === canonicalJson(item.expected) ? "pass" : "fail";
	return { outcome, cost: result.durationMs, evidenceDigest: sha256(canonicalJson(result)) };
}

/** Rechecked immediately before the existing governed merge path. No new permission is granted. */
export async function assertImprovementReady(
	run: ImprovementRun,
	repoRoot: string,
	worktreePath: string,
): Promise<void> {
	if (!measuredRuns.has(run) || run.assessment.status !== "eligible-for-review")
		throw new Error("independent improvement evidence required");
	if (!(await verifyImprovementRun(run))) throw new Error("improvement evidence changed before adoption");
	if ((await readExactHead(repoRoot)) !== run.baselineCommit) throw new Error("baseline advanced since evaluation");
	if ((await readExactHead(worktreePath)) !== run.candidateCommit)
		throw new Error("candidate advanced since evaluation");
	for (const root of new Set([repoRoot, worktreePath])) {
		if ((await git(root, "status", "--porcelain", "--untracked-files=no")).trim())
			throw new Error("tracked files changed before adoption");
	}
}
