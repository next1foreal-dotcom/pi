/**
 * G-206 — mechanical acceptance for dispatched background tasks.
 *
 * The discipline this pins: a worker's own exit code says "I finished", never "it works".
 * Between those two claims sits a set of gate commands Her runs herself, in the task's own
 * worktree, after the worker is already dead. A task can only be reported green when those
 * gates ran and exited 0 — and a self-reported acceptance report is believed only where it
 * matches evidence the runner captured independently.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	ACCEPTANCE_REPORT_FILENAME,
	type AcceptanceRun,
	type GatePlan,
	type GateRun,
	judgeAcceptance,
	loadRepoGatePlan,
	parseGatePlan,
	REPO_GATE_MANIFEST_RELATIVE_PATH,
} from "../src/her-core/bg-task-acceptance.ts";
import { formatWakeMessage, reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { loadBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function tempGitRepo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-acc-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "acc@example.com");
	await git(root, "config", "user.name", "Her Acceptance Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial commit");
	return root;
}

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-acc-mem-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", ""].join("\n"),
		"utf8",
	);
	return root;
}

async function withWorktreeRoot<T>(worktreeRoot: string, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.HER_LONGTASK_WORKTREE_ROOT;
	process.env.HER_LONGTASK_WORKTREE_ROOT = worktreeRoot;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.HER_LONGTASK_WORKTREE_ROOT;
		else process.env.HER_LONGTASK_WORKTREE_ROOT = prev;
	}
}

async function waitForDone(memory: string, id: string, timeoutMs = 30_000): Promise<void> {
	const done = join(tasksDir(memory), `${id}.done`);
	const start = Date.now();
	while (Date.now() - start < timeoutMs && !existsSync(done)) {
		await new Promise((r) => setTimeout(r, 40));
	}
	if (!existsSync(done)) throw new Error(`task ${id} never wrote .done within ${timeoutMs}ms`);
}

function gateRun(overrides: Partial<GateRun> & { name: string }): GateRun {
	return {
		command: [process.execPath, "-e", "0"],
		exitCode: 0,
		outputDigest: "sha256:aaaa",
		outputBytes: 0,
		outputHead: "",
		logPath: `.her/tasks/t-x.${overrides.name}.log`,
		durationMs: 1,
		...overrides,
	};
}

function plan(...names: string[]): GatePlan {
	return { source: "repo", gates: names.map((name) => ({ name, command: [process.execPath, "-e", "0"] })) };
}

function run(...gates: GateRun[]): AcceptanceRun {
	return { gates, startedAt: "2026-08-03T00:00:00.000Z", endedAt: "2026-08-03T00:00:01.000Z" };
}

/* ------------------------------------------------------------------ judge */

test("A1 no gate plan is reported as unverified, never as green", () => {
	const outcome = judgeAcceptance({ plan: null, run: null, report: null });
	assert.equal(outcome.verdict, "unverified");
	assert.equal(outcome.reasons[0]?.code, "no_gates");
});

test("A2 every gate exiting 0 with no self-report is green", () => {
	const outcome = judgeAcceptance({ plan: plan("tests"), run: run(gateRun({ name: "tests" })), report: null });
	assert.equal(outcome.verdict, "green");
	assert.deepEqual(outcome.reasons, []);
});

test("A3 a gate exiting 1 is rejected — a red gate can never read as done", () => {
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", exitCode: 1 })),
		report: null,
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "gate_failed");
	assert.match(outcome.reasons[0]?.detail ?? "", /tests/);
});

test("A4 a gate command that never launched is fail-loud, not green (crash ≠ pass)", () => {
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", exitCode: null, crashed: "spawn ENOENT" })),
		report: null,
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "gate_crashed");
	assert.match(outcome.reasons[0]?.detail ?? "", /ENOENT/);
});

test("A5 a planned gate with no run at all is rejected (silent skip is not a pass)", () => {
	const outcome = judgeAcceptance({ plan: plan("tests", "lint"), run: run(gateRun({ name: "tests" })), report: null });
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "gate_missing");
	assert.match(outcome.reasons[0]?.detail ?? "", /lint/);
});

test("A6 a runner-side error while executing gates is rejected, never silently green", () => {
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: { ...run(gateRun({ name: "tests" })), error: "gates.json unreadable" },
		report: null,
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "runner_error");
});

test("A7 a report claim with no evidence attached is rejected — prose is not evidence", () => {
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests" })),
		report: { claims: [{ claim: "I fixed the bug and everything passes" }] },
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "missing_evidence");
});

test("A8 a claim citing a command no gate ever ran is unverifiable", () => {
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", command: [process.execPath, "--test", "a.test.ts"] })),
		report: {
			claims: [
				{
					claim: "ran the other suite",
					command: [process.execPath, "--test", "totally-different.test.ts"],
					exitCode: 0,
					outputDigest: "sha256:aaaa",
				},
			],
		},
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.equal(outcome.reasons[0]?.code, "claim_unverifiable");
});

test("A9 a claim that contradicts what the runner measured is rejected (forgery pin)", () => {
	const command = [process.execPath, "--test", "a.test.ts"];
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", command, exitCode: 1, outputDigest: "sha256:real" })),
		report: { claims: [{ claim: "all green", command, exitCode: 0, outputDigest: "sha256:forged" }] },
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.ok(outcome.reasons.some((r) => r.code === "claim_unverifiable"));
});

test("A10 a claim that matches the runner's own measurement is accepted", () => {
	const command = [process.execPath, "--test", "a.test.ts"];
	const outcome = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", command, exitCode: 0, outputDigest: "sha256:real" })),
		report: { claims: [{ claim: "suite green", command, exitCode: 0, outputDigest: "sha256:real" }] },
	});
	assert.equal(outcome.verdict, "green");
	assert.deepEqual(outcome.reasons, []);
});

/* ----------------------------------------------------------------- manifest */

test("B1 parseGatePlan rejects a malformed gate instead of quietly dropping it", () => {
	assert.throws(() => parseGatePlan({ gates: [{ name: "x" }] }, "repo"), /command/);
	assert.throws(() => parseGatePlan({ gates: [{ name: "", command: ["node"] }] }, "repo"), /name/);
	assert.throws(() => parseGatePlan({ gates: [{ name: "x", command: [] }] }, "repo"), /command/);
	assert.throws(() => parseGatePlan({ gates: "nope" }, "repo"), /gates/);
});

test("B2 a repo with no gate manifest yields no plan (and no error)", async () => {
	const repo = await tempGitRepo();
	assert.equal(await loadRepoGatePlan(repo), null);
});

test("B3 a repo gate manifest is read from the code root, not from the task's worktree", async () => {
	const repo = await tempGitRepo();
	await mkdir(join(repo, ".pi"), { recursive: true });
	await writeFile(
		join(repo, REPO_GATE_MANIFEST_RELATIVE_PATH),
		JSON.stringify({ gates: [{ name: "tests", command: ["node", "--test", "x.test.ts"] }] }),
		"utf8",
	);
	const loaded = await loadRepoGatePlan(repo);
	assert.equal(loaded?.source, "repo");
	assert.equal(loaded?.gates.length, 1);
	assert.equal(loaded?.gates[0].name, "tests");
});

test("B4 a corrupt gate manifest fails loud rather than degrading to no-gates", async () => {
	const repo = await tempGitRepo();
	await mkdir(join(repo, ".pi"), { recursive: true });
	await writeFile(join(repo, REPO_GATE_MANIFEST_RELATIVE_PATH), "{ not json", "utf8");
	await assert.rejects(() => loadRepoGatePlan(repo), /gate manifest/i);
});

/* ---------------------------------------------------------------------- e2e */

type SpawnedTask = { id: string; memory: string; repo: string | null };

/**
 * `isolate` is off by default on purpose. Building a git repo and a worktree per test is real
 * disk work, and this file runs alongside a latency gate that times git worktree operations —
 * left unchecked, the cost of these fixtures shows up as that gate flaking. Only the cases whose
 * subject *is* the worktree (the headline green/red pair, the code-root manifest, the handoff)
 * pay for one; the rest exercise the same acceptance path with the task directory as the cwd.
 */
async function spawnGatedTask(opts: {
	gates?: { name: string; command: string[] }[];
	workerScript?: string;
	repoManifest?: unknown;
	worktreeRoot?: string;
	isolate?: boolean;
}): Promise<SpawnedTask> {
	const isolate = opts.isolate ?? false;
	const repo = isolate ? await tempGitRepo() : null;
	const memory = await memoryRoot();
	if (repo && opts.repoManifest !== undefined) {
		await mkdir(join(repo, ".pi"), { recursive: true });
		await writeFile(join(repo, REPO_GATE_MANIFEST_RELATIVE_PATH), JSON.stringify(opts.repoManifest), "utf8");
	}
	const result = await spawnBgTask(memory, {
		objective: "gated task",
		command: [process.execPath, "-e", opts.workerScript ?? "process.exit(0)"],
		...(repo ? { isolation: "worktree" as const, codeRoot: repo } : {}),
		skipGates: true,
		heartbeatMs: 1000,
		...(opts.gates ? { gates: opts.gates } : {}),
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") throw new Error("spawn failed");
	await waitForDone(memory, result.id);
	return { id: result.id, memory, repo };
}

test("C1 a task whose gates all pass lands completed with a green verdict", async () => {
	const worktreeRoot = await mkdtemp(join(tmpdir(), "her-acc-wt-"));
	const task = await withWorktreeRoot(worktreeRoot, () =>
		spawnGatedTask({
			worktreeRoot,
			isolate: true,
			gates: [{ name: "ok", command: [process.execPath, "-e", "console.log('gate ok')"] }],
		}),
	);
	const events = await withWorktreeRoot(worktreeRoot, () => reconcileBgTasks(task.memory, { skipRetry: true }));
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "completed");
	const acceptance = loaded?.record.acceptance as { verdict?: string; gates?: unknown[] } | undefined;
	assert.equal(acceptance?.verdict, "green");
	assert.equal(acceptance?.gates?.length, 1);
	assert.equal(events.find((e) => e.taskId === task.id)?.acceptance?.verdict, "green");
});

test("C2 a task whose gate exits 1 is structurally refused completion", async () => {
	const worktreeRoot = await mkdtemp(join(tmpdir(), "her-acc-wt-"));
	const task = await withWorktreeRoot(worktreeRoot, () =>
		spawnGatedTask({
			worktreeRoot,
			isolate: true,
			gates: [{ name: "failing", command: [process.execPath, "-e", "console.error('boom'); process.exit(1)"] }],
		}),
	);
	const events = await withWorktreeRoot(worktreeRoot, () => reconcileBgTasks(task.memory, { skipRetry: true }));
	const loaded = await loadBgTask(task.memory, task.id);

	// The worker itself exited 0 — only the gate failed. Without the gate this task was "done".
	assert.equal(loaded?.record.exitCode, 0);
	assert.notEqual(loaded?.record.status, "completed");
	assert.equal(loaded?.record.status, "failed");
	assert.equal(loaded?.record.failureReason, "acceptance_rejected");
	const acceptance = loaded?.record.acceptance as { verdict?: string; reasons?: { code?: string }[] } | undefined;
	assert.equal(acceptance?.verdict, "rejected-needs-evidence");
	assert.equal(acceptance?.reasons?.[0]?.code, "gate_failed");
	assert.equal(events.find((e) => e.taskId === task.id)?.acceptance?.verdict, "rejected-needs-evidence");
});

test("C3 a gate command that cannot even launch is fail-loud, never a pass", async () => {
	const task = await spawnGatedTask({
		// Allowlisted binary name, but pointed at a script that does not exist: node itself
		// launches and exits non-zero. The pure-crash path (argv[0] missing) is covered by A4;
		// here the point is that a broken gate never yields green.
		gates: [{ name: "broken", command: [process.execPath, "./definitely-not-here.mjs"] }],
	});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "failed");
	assert.equal(loaded?.record.failureReason, "acceptance_rejected");
	const acceptance = loaded?.record.acceptance as { verdict?: string } | undefined;
	assert.equal(acceptance?.verdict, "rejected-needs-evidence");
});

test("C4 a task with no gates keeps its legacy outcome and is labelled unverified", async () => {
	const task = await spawnGatedTask({});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "completed");
	assert.equal(loaded?.record.exitCode, 0);
	const acceptance = loaded?.record.acceptance as { verdict?: string } | undefined;
	assert.equal(acceptance?.verdict, "unverified");
});

test("C5 a worker that fails on its own never runs gates (its own red is the answer)", async () => {
	const task = await spawnGatedTask({
		workerScript: "process.exit(3)",
		gates: [{ name: "never", command: [process.execPath, "-e", "console.log('should not run')"] }],
	});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "failed");
	assert.equal(loaded?.record.failureReason, "nonzero_exit");
	assert.equal(loaded?.record.exitCode, 3);
	assert.equal(existsSync(join(tasksDir(task.memory), `${task.id}.acceptance.json`)), false);
});

test("C6 gates come from the code root, so a worker cannot weaken its own gates", async () => {
	const worktreeRoot = await mkdtemp(join(tmpdir(), "her-acc-wt-"));
	const task = await withWorktreeRoot(worktreeRoot, () =>
		spawnGatedTask({
			worktreeRoot,
			isolate: true,
			repoManifest: { gates: [{ name: "repo-gate", command: [process.execPath, "-e", "process.exit(1)"] }] },
			// The worker deletes the gates out of the manifest inside its own worktree — and files
			// no report at all, so the only thing that can refuse this task is the gate it tried to
			// erase. Were the plan read from the worktree, this task would sail through unverified.
			workerScript: [
				"const fs=require('fs');",
				"fs.mkdirSync('.pi',{recursive:true});",
				`fs.writeFileSync(${JSON.stringify(REPO_GATE_MANIFEST_RELATIVE_PATH)},JSON.stringify({gates:[]}));`,
			].join(""),
		}),
	);
	await withWorktreeRoot(worktreeRoot, () => reconcileBgTasks(task.memory, { skipRetry: true }));
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "failed");
	assert.equal(loaded?.record.failureReason, "acceptance_rejected");
});

test("C8 a worker that files a glowing report while its gates pass still needs the evidence", async () => {
	const task = await spawnGatedTask({
		gates: [{ name: "ok", command: [process.execPath, "-e", "console.log('ok')"] }],
		workerScript: [
			"const fs=require('fs');",
			`fs.writeFileSync(${JSON.stringify(ACCEPTANCE_REPORT_FILENAME)},`,
			"JSON.stringify({claims:[{claim:'I verified everything by hand'}]}));",
		].join(""),
	});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);

	assert.equal(loaded?.record.status, "failed");
	const acceptance = loaded?.record.acceptance as { verdict?: string; reasons?: { code?: string }[] } | undefined;
	assert.equal(acceptance?.verdict, "rejected-needs-evidence");
	assert.equal(acceptance?.reasons?.[0]?.code, "missing_evidence");
});

test("C7 the wake carries the verdict plus the un-merged worktree handoff", async () => {
	const worktreeRoot = await mkdtemp(join(tmpdir(), "her-acc-wt-"));
	const task = await withWorktreeRoot(worktreeRoot, () =>
		spawnGatedTask({
			worktreeRoot,
			isolate: true,
			workerScript: [
				"const fs=require('fs');",
				"fs.writeFileSync('shipped.txt','real work\\n');",
				// Never committed and never added: invisible to `git diff`, but still someone's work.
				"fs.writeFileSync('scratch.md','half-finished thought\\n');",
				"const {execFileSync}=require('child_process');",
				// Only the finished file is staged, exactly as a half-finished run leaves things.
				"execFileSync('git',['add','shipped.txt']);",
				"execFileSync('git',['-c','user.email=w@x','-c','user.name=w','commit','-q','-m','work']);",
			].join(""),
			gates: [{ name: "ok", command: [process.execPath, "-e", "console.log('ok')"] }],
		}),
	);
	const events = await withWorktreeRoot(worktreeRoot, () => reconcileBgTasks(task.memory, { skipRetry: true }));
	const event = events.find((e) => e.taskId === task.id);

	assert.equal(event?.acceptance?.verdict, "green");
	assert.match(String(event?.handoff?.branch), /her-task\//);
	assert.ok(String(event?.handoff?.worktree).length > 0);
	assert.match(String(event?.handoff?.diffStat), /shipped\.txt/);
	// A file the worker never committed is still work someone must decide about, and `git diff`
	// alone cannot see it — under-reporting it at the merge decision is how work gets dropped.
	assert.match(String(event?.handoff?.diffStat), /untracked/);
	assert.match(String(event?.handoff?.diffStat), /scratch\.md/);

	const message = formatWakeMessage(events);
	assert.match(message, /green/);
	assert.match(message, /her-task\//);
	// The handoff is a handoff: nothing in the pipeline merges it, so the code repo it came from
	// is still sitting on its own branch with a clean tree.
	const repo = task.repo;
	assert.ok(repo, "this case runs isolated, so it has a code repo");
	assert.equal((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim(), "master");
	assert.equal((await git(repo, "status", "--porcelain")).stdout.trim(), "");
});

test("A11 only a failing gate carries an excerpt, and it is the tail where the reason lives", () => {
	const failing = judgeAcceptance({
		plan: plan("tests"),
		run: run(
			gateRun({ name: "tests", exitCode: 1, outputHead: "run banner", outputTail: "1 test failed: the reason" }),
		),
		report: null,
	});
	assert.match(String(failing.gates[0].excerpt), /the reason/);

	const passing = judgeAcceptance({
		plan: plan("tests"),
		run: run(gateRun({ name: "tests", exitCode: 0, outputHead: "run banner", outputTail: "all good" })),
		report: null,
	});
	assert.equal(passing.gates[0].excerpt, undefined);
});

test("C9 a failing gate's excerpt reaches the record, secret-redacted", async () => {
	// Assembled at runtime rather than written out: a literal token here would look exactly like a
	// real leaked key to this repo's secret scanner, which is the behaviour we want from it.
	const fakeSecret = `sk${"-"}abcdefghijklmnopqrstuvwxyz012345`;
	const task = await spawnGatedTask({
		gates: [
			{
				name: "leaky",
				command: [
					process.execPath,
					"-e",
					`console.log('failed while calling api_key=' + ${JSON.stringify(fakeSecret)}); process.exit(1)`,
				],
			},
		],
	});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);
	const acceptance = loaded?.record.acceptance as { gates?: { excerpt?: string }[] } | undefined;
	const excerpt = String(acceptance?.gates?.[0]?.excerpt ?? "");

	assert.match(excerpt, /failed while calling/);
	assert.ok(!excerpt.includes(fakeSecret));
	assert.match(excerpt, /REDACTED/);
});

test("D1 a task-declared gate binary outside the allowlist is refused at spawn time", async () => {
	const memory = await memoryRoot();
	const repo = await tempGitRepo();
	await assert.rejects(
		() =>
			spawnBgTask(memory, {
				objective: "evil gate",
				command: [process.execPath, "-e", "process.exit(0)"],
				isolation: "worktree",
				codeRoot: repo,
				skipGates: true,
				gates: [{ name: "evil", command: ["curl", "https://example.invalid"] }],
			}),
		/allowlist/i,
	);
});

test("D2 the gate log referenced by the record really exists and holds the gate's output", async () => {
	const task = await spawnGatedTask({
		gates: [{ name: "chatty", command: [process.execPath, "-e", "console.log('DISTINCTIVE-GATE-OUTPUT')"] }],
	});
	await reconcileBgTasks(task.memory, { skipRetry: true });
	const loaded = await loadBgTask(task.memory, task.id);
	const acceptance = loaded?.record.acceptance as { gates?: { logPath?: string }[] } | undefined;
	const logPath = join(task.memory, String(acceptance?.gates?.[0]?.logPath));

	assert.equal(existsSync(logPath), true);
	assert.match(await readFile(logPath, "utf8"), /DISTINCTIVE-GATE-OUTPUT/);
});
