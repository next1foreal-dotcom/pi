import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalJson, loadImprovementPlan, sha256 } from "../src/her-core/improvement-plan.ts";
import {
	assertImprovementReady,
	readRevisionSnapshot,
	runImprovementExperiment,
	verifyImprovementRun,
} from "../src/her-core/improvement-runner.ts";

const SKILL = "packages/her/pi-package/skills/her-status-brief/SKILL.md";
const EVALUATOR = `import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
const values = JSON.parse(request.artifacts[0].content);
process.stdout.write(JSON.stringify({ observation: values[request.input.key] }));
`;

async function fixture(t: { after(fn: () => Promise<void>): void }, candidate = { known: true, novel: true }) {
	const root = await mkdtemp(join(tmpdir(), "her-evolution-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo"),
		worktree = join(root, "candidate"),
		memory = join(root, "memory");
	await mkdir(repo);
	await mkdir(join(memory, "evals/selfmod-improvement/evaluators"), { recursive: true });
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			},
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git(repo, "init", "-q");
	git(repo, "config", "user.name", "Fixture");
	git(repo, "config", "user.email", "fixture@example.invalid");
	await mkdir(dirname(join(repo, SKILL)), { recursive: true });
	await writeFile(join(repo, SKILL), JSON.stringify({ known: true, novel: false }));
	git(repo, "add", SKILL);
	git(repo, "commit", "-qm", "fixture baseline");
	const baseline = git(repo, "rev-parse", "HEAD");
	git(repo, "worktree", "add", "--detach", worktree, baseline);
	await writeFile(join(worktree, SKILL), JSON.stringify(candidate));
	git(worktree, "add", SKILL);
	git(worktree, "commit", "-qm", "fixture candidate");
	const evaluatorPath = "evals/selfmod-improvement/evaluators/deterministic.mjs";
	await writeFile(join(memory, evaluatorPath), EVALUATOR);
	const raw = {
		version: 1,
		proposalId: "selfmod-fixture",
		baselineCommit: baseline,
		targets: [SKILL],
		trainingInputDigests: [] as string[],
		cases: [
			{ id: "old", split: "regression", input: { key: "known" }, expected: true },
			{ id: "new", split: "holdout", input: { key: "novel" }, expected: true },
		],
		minHoldoutGain: 1,
		maxTotalCostMs: 20_000,
		priorExperimentCostMs: 0,
		timeoutMs: 2000,
		maxOutputBytes: 8192,
		evaluator: { path: evaluatorPath, sha256: sha256(EVALUATOR) },
	};
	const planPath = join(memory, "evals/selfmod-improvement/selfmod-fixture.json");
	const save = () => writeFile(planPath, JSON.stringify(raw));
	await save();
	const load = () =>
		loadImprovementPlan({
			memoryDir: memory,
			proposalId: raw.proposalId,
			baselineCommit: baseline,
			targetPaths: [SKILL],
		});
	const evaluate = async () =>
		runImprovementExperiment({
			plan: await load(),
			worktreePath: worktree,
			auditRoot: join(memory, "audit/improvement"),
		});
	const setEvaluator = async (source: string) => {
		await writeFile(join(memory, evaluatorPath), source);
		raw.evaluator.sha256 = sha256(source);
		await save();
	};
	return {
		root,
		repo,
		worktree,
		memory,
		baseline,
		raw,
		save,
		load,
		evaluate,
		setEvaluator,
		git,
		planPath,
		evaluatorPath,
	};
}

test("actual child processes compare exact Git revisions and write verifiable evidence", async (t) => {
	const f = await fixture(t);
	const run = await f.evaluate();
	assert.equal(run.assessment.status, "eligible-for-review");
	assert.equal(run.assessment.holdoutGain, 1);
	assert.ok((run.assessment.totalCost ?? 0) > 0);
	assert.equal(await verifyImprovementRun(run), true);
	await assertImprovementReady(run, f.repo, f.worktree);
	assert.equal(f.git(f.repo, "rev-parse", "HEAD"), f.baseline); // Runner never merges.
	const report = JSON.parse(await readFile(join(run.auditDir, "report.json"), "utf8"));
	assert.equal(report.evidence.cases.length, 2);
	assert.equal(report.costUnit, "elapsed-ms");
});

test("regression rejects even when a new case improves", async (t) => {
	const f = await fixture(t, { known: false, novel: true });
	const run = await f.evaluate();
	assert.equal(run.assessment.status, "rejected");
	assert.ok(run.assessment.reasons.includes("regression:old"));
	await assert.rejects(assertImprovementReady(run, f.repo, f.worktree), /improvement evidence/);
});

test("a changed skill without held-out gain cannot qualify", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.worktree, SKILL), '{"novel":false,"known":true}\n');
	f.git(f.worktree, "add", SKILL);
	f.git(f.worktree, "commit", "-qm", "fixture no gain");
	assert.equal((await f.evaluate()).assessment.status, "rejected");
});

test("missing independent plan fails closed", async (t) => {
	const f = await fixture(t);
	await rm(f.planPath);
	await assert.rejects(f.load());
});

test("frozen plan retains the pre-apply suite after files are edited", async (t) => {
	const f = await fixture(t);
	const plan = await f.load();
	f.raw.cases[1].expected = false;
	await f.save();
	await writeFile(join(f.memory, f.evaluatorPath), "throw new Error('tampered');");
	const run = await runImprovementExperiment({
		plan,
		worktreePath: f.worktree,
		auditRoot: join(f.memory, "audit/improvement"),
	});
	assert.equal(run.assessment.status, "eligible-for-review");
	assert.throws(() => {
		(plan.cases[1] as { expected: unknown }).expected = false;
	}, TypeError);
});

test("a deserialized plan is not a host-frozen plan", async (t) => {
	const f = await fixture(t);
	const plan = JSON.parse(JSON.stringify(await f.load()));
	await assert.rejects(
		runImprovementExperiment({ plan, worktreePath: f.worktree, auditRoot: join(f.memory, "audit") }),
		/host-frozen/,
	);
});

test("wrong proposal baseline or targets reject", async (t) => {
	const f = await fixture(t);
	f.raw.baselineCommit = "f".repeat(40);
	await f.save();
	await assert.rejects(f.load(), /bound/);
	f.raw.baselineCommit = f.baseline;
	f.raw.targets = ["packages/her/src/extension.ts"];
	await f.save();
	await assert.rejects(f.load(), /targets/);
});

test("duplicate cases and training leakage reject", async (t) => {
	const f = await fixture(t);
	f.raw.trainingInputDigests = [sha256(canonicalJson(f.raw.cases[1].input))];
	await f.save();
	await assert.rejects(f.load(), /overlapping/);
	f.raw.trainingInputDigests = [];
	f.raw.cases[1].id = "old";
	await f.save();
	await assert.rejects(f.load(), /duplicate/);
});

test("evaluator digest mismatch rejects", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.memory, f.evaluatorPath), "process.exit(0)");
	await assert.rejects(f.load(), /digest mismatch/);
});

test("symlinked evaluation manifests reject", async (t) => {
	const f = await fixture(t);
	const target = join(f.root, "elsewhere.json");
	await writeFile(target, JSON.stringify(f.raw));
	await rm(f.planPath);
	await symlink(target, f.planPath);
	await assert.rejects(f.load(), /symlink/);
});

test("symlinked revision targets reject rather than reading the link target", async (t) => {
	const f = await fixture(t);
	await rm(join(f.worktree, SKILL));
	await symlink("/etc/passwd", join(f.worktree, SKILL));
	f.git(f.worktree, "add", SKILL);
	f.git(f.worktree, "commit", "-qm", "fixture link");
	await assert.rejects(
		readRevisionSnapshot(f.worktree, f.git(f.worktree, "rev-parse", "HEAD"), [SKILL]),
		/regular tracked/,
	);
});

test("unplanned candidate changes reject before evaluation", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.worktree, "policy.txt"), "changed");
	f.git(f.worktree, "add", "policy.txt");
	f.git(f.worktree, "commit", "-qm", "fixture out of scope");
	await assert.rejects(f.evaluate(), /unplanned/);
});

test("uncommitted candidate changes reject", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.worktree, SKILL), "dirty");
	await assert.rejects(f.evaluate(), /uncommitted/);
});

test("a success assertion is not an observed result", async (t) => {
	const f = await fixture(t);
	await f.setEvaluator("process.stdout.write(JSON.stringify({ pass: true, score: 1 }));");
	assert.equal((await f.evaluate()).assessment.status, "needs-evidence");
});

test("exiting zero without any result cannot qualify", async (t) => {
	const f = await fixture(t);
	await f.setEvaluator("process.exit(0);");
	assert.equal((await f.evaluate()).assessment.status, "needs-evidence");
});

test("nonzero evaluator exit cannot qualify", async (t) => {
	const f = await fixture(t);
	await f.setEvaluator("process.exit(7);");
	assert.equal((await f.evaluate()).assessment.status, "needs-evidence");
});

test("a hung evaluator is stopped by the timeout", async (t) => {
	const f = await fixture(t);
	await f.setEvaluator("setInterval(() => {}, 1000);");
	f.raw.timeoutMs = 100;
	await f.save();
	const run = await f.evaluate();
	assert.equal(run.assessment.status, "needs-evidence");
	assert.match(run.assessment.reasons.join(), /timed out/);
});

test("excessive evaluator output is bounded and cannot qualify", async (t) => {
	const f = await fixture(t);
	await f.setEvaluator("process.stdout.write('x'.repeat(100000));");
	f.raw.maxOutputBytes = 128;
	await f.save();
	const run = await f.evaluate();
	assert.equal(run.assessment.status, "needs-evidence");
	assert.match(run.assessment.reasons.join(), /limit/);
	assert.ok((await readFile(join(run.auditDir, "0-baseline.stdout"))).length <= 128);
});

test("an exhausted total budget prevents a successful assessment", async (t) => {
	const f = await fixture(t);
	f.raw.maxTotalCostMs = 1;
	await f.save();
	const run = await f.evaluate();
	assert.notEqual(run.assessment.status, "eligible-for-review");
});

test("audit artifact tampering is caught before adoption", async (t) => {
	const f = await fixture(t);
	const run = await f.evaluate();
	await writeFile(join(run.auditDir, "0-baseline.stdout"), "forged");
	assert.equal(await verifyImprovementRun(run), false);
	await assert.rejects(assertImprovementReady(run, f.repo, f.worktree), /evidence changed/);
});

test("a copied success receipt cannot grant adoption", async (t) => {
	const f = await fixture(t);
	const run = await f.evaluate();
	await assert.rejects(assertImprovementReady({ ...run }, f.repo, f.worktree), /independent/);
});

test("baseline advancement invalidates the old measurement", async (t) => {
	const f = await fixture(t);
	const run = await f.evaluate();
	await writeFile(join(f.repo, SKILL), "advanced");
	f.git(f.repo, "add", SKILL);
	f.git(f.repo, "commit", "-qm", "fixture later baseline");
	await assert.rejects(assertImprovementReady(run, f.repo, f.worktree), /baseline advanced/);
});

test("candidate advancement invalidates the old measurement", async (t) => {
	const f = await fixture(t);
	const run = await f.evaluate();
	await writeFile(join(f.worktree, SKILL), "advanced");
	f.git(f.worktree, "add", SKILL);
	f.git(f.worktree, "commit", "-qm", "fixture later candidate");
	await assert.rejects(assertImprovementReady(run, f.repo, f.worktree), /candidate advanced/);
});

test("aborted evaluation does not launch work", async (t) => {
	const f = await fixture(t);
	const control = new AbortController();
	control.abort();
	await assert.rejects(
		runImprovementExperiment({
			plan: await f.load(),
			worktreePath: f.worktree,
			auditRoot: join(f.memory, "audit"),
			signal: control.signal,
		}),
		/aborted/,
	);
});

test("audit files cannot live inside candidate worktree", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		runImprovementExperiment({
			plan: await f.load(),
			worktreePath: f.worktree,
			auditRoot: join(f.worktree, "audit"),
		}),
		/outside/,
	);
});

test("JSON canonicalization is order-independent and rejects unsupported numbers", () => {
	assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
	assert.throws(() => canonicalJson(NaN));
	assert.throws(() => canonicalJson({ value: undefined }));
});

test("revision checks preserve the host Git line-ending configuration", async (t) => {
	const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
	const saved = names.map((name) => process.env[name]);
	process.env.GIT_CONFIG_COUNT = "1";
	process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
	process.env.GIT_CONFIG_VALUE_0 = "true";
	try {
		const f = await fixture(t);
		await writeFile(
			join(f.worktree, SKILL),
			`${JSON.stringify({ known: true, novel: true }, null, 2).replaceAll("\n", "\r\n")}\r\n`,
		);
		f.git(f.worktree, "add", SKILL);
		f.git(f.worktree, "commit", "-qm", "fixture CRLF checkout");
		assert.equal(f.git(f.worktree, "--no-optional-locks", "status", "--porcelain"), "");
		const run = await f.evaluate();
		assert.equal(run.assessment.status, "eligible-for-review");
		await assertImprovementReady(run, f.repo, f.worktree);
	} finally {
		names.forEach((name, i) => {
			if (saved[i] === undefined) delete process.env[name];
			else process.env[name] = saved[i];
		});
	}
});
