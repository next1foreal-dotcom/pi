import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { purgeExpiredTaskArtifacts } from "../src/her-core/bg-task-retention.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import { resolveWorkerCommand } from "../src/her-core/task-executor.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-worker-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	return root;
}

async function writeConfig(root: string, yaml: string): Promise<void> {
	await writeFile(join(root, ".her", "config.yaml"), yaml, "utf8");
}

/** Fixture worker script: reads (and discards) stdin, then prints its own env var keys, one per line. */
async function writePrintEnvKeysFixture(dir: string, name = "print-env-keys.mjs"): Promise<string> {
	const path = join(dir, name);
	await writeFile(
		path,
		[
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  process.stdout.write(Object.keys(process.env).join('\\n'));",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

/** Fixture worker script: reads stdin to completion, writes it back out byte-for-byte. */
async function writeEchoStdinFixture(dir: string, name = "echo-stdin.mjs"): Promise<string> {
	const path = join(dir, name);
	await writeFile(
		path,
		[
			"const chunks = [];",
			"process.stdin.on('data', (c) => chunks.push(c));",
			"process.stdin.on('end', () => {",
			"  process.stdout.write(Buffer.concat(chunks));",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	return path;
}

function workersYaml(name: string, argv: string[], envAllow?: string[]): string {
	const argvLit = `[${argv.map((a) => `"${a}"`).join(", ")}]`;
	const lines = ["workers:", `  ${name}:`, `    argv: ${argvLit}`];
	if (envAllow) lines.push(`    env_allow: [${envAllow.map((e) => `"${e}"`).join(", ")}]`);
	return lines.join("\n");
}

async function readdirSafe(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

async function waitForDone(root: string, id: string, ms = 15_000): Promise<void> {
	const donePath = join(tasksDir(root), `${id}.done`);
	const start = Date.now();
	while (Date.now() - start < ms) {
		try {
			await readFile(donePath, "utf8");
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error(`timeout waiting for ${id}.done`);
}

test("AC1: worker mode spawns config-defined CLI, brief flows via stdin verbatim", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));

	const brief = 'hello ^&"line one\nline two <end>';
	const result = await spawnBgTask(root, {
		objective: "AC1 worker echo",
		worker: "fake",
		brief,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	await waitForDone(root, result.id);
	const done = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.done`), "utf8"));
	assert.equal(done.exitCode, 0);

	const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
	assert.equal(log, brief);

	const loaded = await loadBgTask(root, result.id);
	assert.equal(loaded?.record.mode, "worker");
});

test("AC2: unknown worker profile throws with available-keys list, zero file residual", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));

	await assert.rejects(
		() => spawnBgTask(root, { objective: "AC2", worker: "nope", brief: "hi", skipGates: true }),
		(err: Error) => {
			assert.match(err.message, /fake/);
			return true;
		},
	);

	const entries = await readdirSafe(tasksDir(root));
	assert.deepEqual(
		entries.filter((n) => n.endsWith(".pid") || n.endsWith(".brief")),
		[],
	);
});

test("AC3: command+brief together, or neither, is a parameter error with zero file residual", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));

	await assert.rejects(() =>
		spawnBgTask(root, {
			objective: "both",
			worker: "fake",
			brief: "hi",
			command: [process.execPath, fixture],
			skipGates: true,
		}),
	);
	await assert.rejects(() => spawnBgTask(root, { objective: "neither", skipGates: true }));

	assert.deepEqual(await readdirSafe(tasksDir(root)), []);
});

test("AC4: bare-command allowlist — not-allowlisted rejected, config-registered bare name passes the gate, path in argv[0] rejected", async () => {
	const root = await memoryRoot();
	// Not on DEFAULT_ALLOW and no worker profile names it → rejected before any file write.
	await assert.rejects(() =>
		spawnBgTask(root, { objective: "python", command: ["python", "-c", "1"], skipGates: true }),
	);

	// A worker profile named "zzz-her-test-cli" adds that bare name to the allowlist even though the
	// binary itself does not exist — the allowlist gate must not throw for it (D2's "放行"); whatever
	// happens afterwards at actual launch (ENOENT) is a separate, later concern.
	await writeConfig(root, workersYaml("zzz-her-test-cli", ["zzz-her-test-cli", "--noop"]));
	// Must not throw (the allowlist gate must pass); if it did throw, the `await` below fails the test.
	const result = await spawnBgTask(root, {
		objective: "bare registered name",
		command: ["zzz-her-test-cli"],
		skipGates: true,
	});
	// The synchronous dispatch always reports "running" (it launched the detached runner); the
	// runner itself then fails fast (spawn ENOENT — the binary genuinely does not exist) and exits
	// on its own. Wait for that exit so no background process is left running before this returns.
	assert.equal(result.status, "running");
	if (result.status === "running") {
		await waitForDone(root, result.id);
		await stopBgTask(root, result.id);
	}

	// argv[0] containing a path separator is rejected outright (D2), even if it "looks like" a worker name.
	await assert.rejects(() =>
		spawnBgTask(root, { objective: "path", command: ["C:\\evil\\codex.exe"], skipGates: true }),
	);
});

test("AC5: brief over 64KB but under cap completes; brief over the cap is rejected with zero residual", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(
		root,
		[workersYaml("fake", [process.execPath, fixture]), "tasks:", "  brief_cap_bytes: 100000", ""].join("\n"),
	);

	const bigBrief = `${"x".repeat(70_000)}\nEND-MARKER`;
	const result = await spawnBgTask(root, {
		objective: "big brief",
		worker: "fake",
		brief: bigBrief,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;
	await waitForDone(root, result.id);
	const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
	assert.match(log, /END-MARKER$/);

	const before = await readdirSafe(tasksDir(root));
	const overCap = "y".repeat(200_000);
	await assert.rejects(() =>
		spawnBgTask(root, { objective: "over cap", worker: "fake", brief: overCap, skipGates: true }),
	);
	const after = await readdirSafe(tasksDir(root));
	assert.deepEqual(after.sort(), before.sort()); // rejected spawn left zero new files
});

test(
	"AC6: Windows .cmd shim (in a spaced directory) runs via cmd.exe /d /s /c with stdin connected",
	{ skip: process.platform !== "win32" },
	async () => {
		const root = await memoryRoot();
		const spacedDir = join(root, "dir with space");
		await mkdir(spacedDir, { recursive: true });
		const script = await writeEchoStdinFixture(spacedDir);
		const cmdPath = join(spacedDir, "echo-stdin.cmd");
		await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${script}"\r\n`, "utf8");

		await writeConfig(root, workersYaml("winshim", [cmdPath]));

		const brief = 'special ^&"chars\nsecond line <end>';
		const result = await spawnBgTask(root, {
			objective: "AC6 cmd shim",
			worker: "winshim",
			brief,
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const done = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.done`), "utf8"));
		assert.equal(done.exitCode, 0);
		const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
		assert.equal(log, brief);
	},
);

test("AC8: .brief purges alongside .pid/.log once retention_days has elapsed; survives while fresh", async () => {
	const root = await memoryRoot();
	await writeConfig(root, "tasks:\n  retention_days: 30\n");
	const dir = tasksDir(root);

	const oldRecord: BgTaskRecord = {
		id: "t-20200101-old",
		status: "completed",
		objective: "old worker task",
		worker: "fake",
		mode: "worker",
		command: [process.execPath],
		created: "2020-01-01T00:00:00.000Z",
		updated: "2020-01-01T00:00:00.000Z",
		endedAt: "2020-01-01T00:00:00.000Z",
		retries: 0,
		host: "box",
		notifiedAt: "2020-01-01T00:00:00.000Z",
	};
	await saveBgTask(root, oldRecord, "# old\n");
	await writeFile(join(dir, `${oldRecord.id}.log`), "log\n", "utf8");
	await writeFile(join(dir, `${oldRecord.id}.pid`), '{"runnerPid":1}\n', "utf8");
	await writeFile(join(dir, `${oldRecord.id}.brief`), "old brief\n", "utf8");

	const freshRecord: BgTaskRecord = {
		...oldRecord,
		id: "t-20260726-fresh",
		created: "2026-07-20T00:00:00.000Z",
		updated: "2026-07-20T00:00:00.000Z",
		endedAt: "2026-07-20T00:00:00.000Z",
		notifiedAt: "2026-07-20T00:00:00.000Z",
	};
	await saveBgTask(root, freshRecord, "# fresh\n");
	await writeFile(join(dir, `${freshRecord.id}.brief`), "fresh brief\n", "utf8");

	const purged = await purgeExpiredTaskArtifacts(root, {
		now: new Date("2026-07-26T00:00:00.000Z"),
		retentionDays: 30,
	});
	assert.equal(purged.length, 1);
	assert.ok(purged[0]?.removed.includes(`${oldRecord.id}.brief`));
	await assert.rejects(() => readFile(join(dir, `${oldRecord.id}.brief`)));
	assert.equal(await readFile(join(dir, `${freshRecord.id}.brief`), "utf8"), "fresh brief\n");
});

test("AC10: worker env is the minimal allowlist — no HER_LLM_API_KEY unless env_allow names it", async () => {
	const root = await memoryRoot();
	const fixture = await writePrintEnvKeysFixture(root);
	await writeConfig(root, workersYaml("envcheck", [process.execPath, fixture]));

	const prevKey = process.env.HER_LLM_API_KEY;
	process.env.HER_LLM_API_KEY = "sk-should-not-leak";
	try {
		const result = await spawnBgTask(root, {
			objective: "AC10 no leak",
			worker: "envcheck",
			brief: "x",
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const keys = (await readFile(join(tasksDir(root), `${result.id}.log`), "utf8")).split("\n");
		assert.ok(!keys.includes("HER_LLM_API_KEY"));
		assert.ok(keys.includes("PATH"));
		assert.ok(keys.includes("HER_TASK_ID"));
	} finally {
		if (prevKey === undefined) delete process.env.HER_LLM_API_KEY;
		else process.env.HER_LLM_API_KEY = prevKey;
	}
});

test("AC10b: env_allow additionally exposes the named variable to the worker", async () => {
	const root = await memoryRoot();
	const fixture = await writePrintEnvKeysFixture(root);
	await writeConfig(root, workersYaml("envcheck2", [process.execPath, fixture], ["FOO"]));

	const prevFoo = process.env.FOO;
	process.env.FOO = "bar";
	try {
		const result = await spawnBgTask(root, {
			objective: "AC10b env_allow",
			worker: "envcheck2",
			brief: "x",
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const keys = (await readFile(join(tasksDir(root), `${result.id}.log`), "utf8")).split("\n");
		assert.ok(keys.includes("FOO"));
	} finally {
		if (prevFoo === undefined) delete process.env.FOO;
		else process.env.FOO = prevFoo;
	}
});

test("AC11: mode:worker auto-retry rebuilds the worker invocation and the child reads the original brief from stdin", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));
	const dir = tasksDir(root);

	const brief = "original brief content for retry";
	const id = "t-20260726-neverstarted";
	const record: BgTaskRecord = {
		id,
		status: "pending",
		objective: "AC11 retry",
		worker: "fake",
		mode: "worker",
		command: [process.execPath, fixture],
		created: "2020-01-01T00:00:00.000Z",
		updated: "2020-01-01T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
	};
	await saveBgTask(root, record, "# never\n");
	await writeFile(join(dir, `${id}.brief`), brief, "utf8");

	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: new Date("2026-07-26T12:00:00.000Z"),
		launchGraceSeconds: 1,
		heartbeatSeconds: 1000,
	});
	assert.equal(events[0]?.failureReason, "never_started");
	const retryId = events[0]?.retryTaskId;
	assert.ok(retryId);
	if (!retryId) return;

	const child = await loadBgTask(root, retryId);
	assert.equal(child?.record.mode, "worker");
	assert.equal(child?.record.parentTask, id);

	await waitForDone(root, retryId);
	const log = await readFile(join(dir, `${retryId}.log`), "utf8");
	assert.equal(log, brief);
});

test("AC12: reconcile posts a cost-ledger entry = budgetReserved once per task; a second reconcile does not duplicate it", async () => {
	const root = await memoryRoot();
	const dir = tasksDir(root);
	const id = "t-20260726-costcheck";
	const record: BgTaskRecord = {
		id,
		status: "running",
		objective: "AC12 cost",
		worker: "cheap_worker",
		mode: "command",
		command: [process.execPath, "-e", "console.log('done')"],
		created: "2026-01-01T00:00:00.000Z",
		updated: "2026-01-01T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
		budgetReserved: 5,
	};
	await saveBgTask(root, record, "# cost\n");
	await writeFile(
		join(dir, `${id}.done`),
		JSON.stringify({ exitCode: 0, endedAt: "2026-07-26T12:00:00.000Z" }),
		"utf8",
	);

	const now = new Date("2026-07-26T12:00:00.000Z");
	const first = await reconcileBgTasks(root, { hostname: "THIS-BOX", now, skipRetry: true });
	assert.equal(first.length, 1);

	const auditPath = join(root, "audit", "2026-07-26.jsonl");
	const linesAfterFirst = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
	assert.equal(linesAfterFirst.length, 1);
	const entry = JSON.parse(linesAfterFirst[0] ?? "{}");
	assert.equal(entry.cost.usd, 5);

	const loaded = await loadBgTask(root, id);
	assert.ok(loaded?.record.costSettledAt);

	const second = await reconcileBgTasks(root, { hostname: "THIS-BOX", now, skipRetry: true });
	assert.equal(second.length, 0); // already notified — no new wake, and no new ledger line
	const linesAfterSecond = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
	assert.equal(linesAfterSecond.length, 1);
});

test("AC13: HER_TASK_STDIN/CWD/HEARTBEAT_MS residue in the launcher's own env does not leak into a bare-command task", async () => {
	const root = await memoryRoot();
	const fixture = await writePrintEnvKeysFixture(root);

	const prev = {
		STDIN: process.env.HER_TASK_STDIN,
		CWD: process.env.HER_TASK_CWD,
		HB: process.env.HER_TASK_HEARTBEAT_MS,
	};
	process.env.HER_TASK_STDIN = join(root, "leaked-brief-should-not-be-used.txt");
	process.env.HER_TASK_CWD = join(root, "leaked-cwd-should-not-be-used");
	process.env.HER_TASK_HEARTBEAT_MS = "999999";
	try {
		const result = await spawnBgTask(root, {
			objective: "AC13 no leak",
			command: [process.execPath, fixture],
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const keys = (await readFile(join(tasksDir(root), `${result.id}.log`), "utf8")).split("\n");
		// The fixture prints its own env keys; HER_TASK_STDIN/CWD were never set for this bare-command
		// call (no worktree, no brief), so the leaked parent-process values must not show up at all —
		// if they did, the runner would have tried to open the (nonexistent) leaked stdin path and the
		// task would have failed with brief_missing instead of completing.
		const done = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.done`), "utf8"));
		assert.equal(done.exitCode, 0);
		assert.equal(done.detail, null);
		assert.ok(keys.includes("HER_TASK_ID"));
	} finally {
		for (const [k, v] of Object.entries({
			HER_TASK_STDIN: prev.STDIN,
			HER_TASK_CWD: prev.CWD,
			HER_TASK_HEARTBEAT_MS: prev.HB,
		})) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
});

test("AC14: an API-key-shaped secret in the brief is redacted before it hits disk", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));

	const secret = `sk-${"a".repeat(30)}`;
	const brief = `here is a key: ${secret} end of brief`;
	const result = await spawnBgTask(root, {
		objective: "AC14 redact",
		worker: "fake",
		brief,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	const onDisk = await readFile(join(tasksDir(root), `${result.id}.brief`), "utf8");
	assert.ok(!onDisk.includes(secret));
	assert.match(onDisk, /«REDACTED:secret»/);

	await waitForDone(root, result.id);
});

test(
	"AC9: npm-shim candidate selection — .exe/.com wins outright; extensionless+.cmd falls back to cmd.exe on the .cmd, never the extensionless script",
	{ skip: process.platform !== "win32" },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "her-where-fixture-"));
		// npm-shim layout: an extensionless sh script (not a PE binary) + a .cmd — where.exe lists the
		// extensionless one first. D7: spawning it directly fails on Windows, so it must never be chosen.
		await writeFile(join(dir, "shimonly"), "#!/bin/sh\necho hi\n", "utf8");
		await writeFile(join(dir, "shimonly.cmd"), "@echo off\r\necho hi\r\n", "utf8");
		// A second name that also has a real .exe candidate — that must win outright.
		await writeFile(join(dir, "hasexe"), "#!/bin/sh\necho hi\n", "utf8");
		await writeFile(join(dir, "hasexe.cmd"), "@echo off\r\necho hi\r\n", "utf8");
		await writeFile(join(dir, "hasexe.exe"), "not a real PE, resolveWorkerCommand never runs it", "utf8");

		const prevPath = process.env.PATH;
		process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${prevPath}`;
		try {
			const shimOnly = resolveWorkerCommand(["shimonly", "--x"]);
			// `file` is what actually gets spawned — cmd.exe here means the extensionless script is
			// never spawned directly (that would fail: it is a sh script, not a PE binary on Windows).
			assert.match(shimOnly.file.toLowerCase(), /cmd\.exe$/);
			assert.match(shimOnly.args.join(" "), /shimonly\.cmd/i);

			const hasExe = resolveWorkerCommand(["hasexe", "--y"]);
			assert.match(hasExe.file.toLowerCase(), /hasexe\.exe$/);
			assert.deepEqual(hasExe.args, ["--y"]);
		} finally {
			process.env.PATH = prevPath;
		}
	},
);

test(
	"F1: bare-command mode never reaches cmd.exe — a bare name resolving only to a .cmd shim is refused (failed/never_started, error names 'worker profile'); the same layout still works under worker/profile mode",
	{ skip: process.platform !== "win32" },
	async () => {
		const root = await memoryRoot();
		const dir = await mkdtemp(join(tmpdir(), "her-f1-fixture-"));
		const script = await writeEchoStdinFixture(dir);
		const cmdPath = join(dir, "cmdonly-shim.cmd");
		await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${script}"\r\n`, "utf8");
		// Deliberately no .exe/.com candidate for this name — where.exe can only resolve to the .cmd.
		await writeConfig(root, workersYaml("cmdonly", ["cmdonly-shim"]));

		const prevPath = process.env.PATH;
		process.env.PATH = `${dir};${prevPath}`;
		try {
			// Bare command mode: "cmdonly-shim" passes the allowlist (matches workers.cmdonly.argv[0]),
			// but resolving it lands on a .cmd — F1 must refuse before ever handing it to cmd.exe.
			const bare = await spawnBgTask(root, {
				objective: "F1 bare comspec ban",
				command: ["cmdonly-shim"],
				skipGates: true,
				heartbeatMs: 1000,
			});
			assert.equal(bare.status, "failed");
			if (bare.status === "failed") {
				assert.equal(bare.failureReason, "never_started");
				assert.match(bare.error, /worker profile/);
			}
			assert.deepEqual(await readdirSafe(tasksDir(root)).then((n) => n.filter((f) => f.endsWith(".pid"))), []);

			// Worker/profile mode: the identical cmd-only layout must still work (no regression).
			const worker = await spawnBgTask(root, {
				objective: "F1 worker mode still works",
				worker: "cmdonly",
				brief: "hello from worker mode",
				skipGates: true,
				heartbeatMs: 1000,
			});
			assert.equal(worker.status, "running");
			if (worker.status !== "running") return;
			await waitForDone(root, worker.id);
			const done = JSON.parse(await readFile(join(tasksDir(root), `${worker.id}.done`), "utf8"));
			assert.equal(done.exitCode, 0);
			const log = await readFile(join(tasksDir(root), `${worker.id}.log`), "utf8");
			assert.equal(log, "hello from worker mode");
		} finally {
			process.env.PATH = prevPath;
		}
	},
);

test(
	"F2: config argv tokens containing & | ^ survive the cmd.exe shim chain unmangled",
	{ skip: process.platform !== "win32" },
	async () => {
		const root = await memoryRoot();
		const dir = await mkdtemp(join(tmpdir(), "her-f2-fixture-"));
		// Echoes its first argument back out via node (avoids relying on batch's own %1 quoting quirks).
		const echoArgPath = join(dir, "echo-arg.mjs");
		await writeFile(echoArgPath, "process.stdout.write(process.argv[2] ?? '');\n", "utf8");
		const cmdPath = join(dir, "echo-arg.cmd");
		await writeFile(cmdPath, `@echo off\r\n"${process.execPath}" "${echoArgPath}" %1\r\n`, "utf8");

		const specialToken = "a&b|c^d";
		await writeConfig(root, workersYaml("f2check", [cmdPath, specialToken]));

		const result = await spawnBgTask(root, {
			objective: "F2 quoting",
			worker: "f2check",
			brief: "irrelevant",
			skipGates: true,
			heartbeatMs: 1000,
		});
		assert.equal(result.status, "running");
		if (result.status !== "running") return;
		await waitForDone(root, result.id);
		const done = JSON.parse(await readFile(join(tasksDir(root), `${result.id}.done`), "utf8"));
		assert.equal(done.exitCode, 0);
		const log = await readFile(join(tasksDir(root), `${result.id}.log`), "utf8");
		assert.equal(log, specialToken);
	},
);

test("F3: cost settlement survives a crash between ledger-append and record-save (scans the day's ledger, not just costSettledAt)", async () => {
	const root = await memoryRoot();
	const dir = tasksDir(root);
	const id = "t-20260726-f3crash";
	const record: BgTaskRecord = {
		id,
		status: "running",
		objective: "F3 crash window",
		worker: "cheap_worker",
		mode: "command",
		command: [process.execPath, "-e", "console.log('done')"],
		created: "2026-01-01T00:00:00.000Z",
		updated: "2026-01-01T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
		budgetReserved: 7,
	};
	await saveBgTask(root, record, "# f3\n");
	await writeFile(
		join(dir, `${id}.done`),
		JSON.stringify({ exitCode: 0, endedAt: "2026-07-26T12:00:00.000Z" }),
		"utf8",
	);

	const now = new Date("2026-07-26T12:00:00.000Z");
	await reconcileBgTasks(root, { hostname: "THIS-BOX", now, skipRetry: true });

	const auditPath = join(root, "audit", "2026-07-26.jsonl");
	const linesAfterFirst = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
	assert.equal(linesAfterFirst.length, 1);

	// Simulate a crash between the ledger append and the record save that would have recorded
	// costSettledAt/notifiedAt: strip both, forcing this task back through terminal processing.
	const afterFirst = await loadBgTask(root, id);
	assert.ok(afterFirst);
	if (!afterFirst) return;
	const crashed = { ...afterFirst.record };
	delete crashed.costSettledAt;
	delete crashed.notifiedAt;
	await saveBgTask(root, crashed, afterFirst.body);

	await reconcileBgTasks(root, { hostname: "THIS-BOX", now, skipRetry: true });
	const linesAfterSecond = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
	assert.equal(linesAfterSecond.length, 1); // still just 1 — the ledger scan caught the prior entry
});

test("F4: worker-mode retry with a missing .brief does not spawn a replacement task and marks the wake event retrySkipped:'brief_missing'", async () => {
	const root = await memoryRoot();
	const fixture = await writeEchoStdinFixture(root);
	await writeConfig(root, workersYaml("fake", [process.execPath, fixture]));
	const dir = tasksDir(root);

	const id = "t-20260726-f4nobrief";
	const record: BgTaskRecord = {
		id,
		status: "pending",
		objective: "F4 missing brief",
		worker: "fake",
		mode: "worker",
		command: [process.execPath, fixture],
		created: "2020-01-01T00:00:00.000Z",
		updated: "2020-01-01T00:00:00.000Z",
		retries: 0,
		host: "THIS-BOX",
	};
	await saveBgTask(root, record, "# f4\n");
	// Deliberately no .brief file on disk for this task.

	const before = await readdirSafe(dir);
	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: new Date("2026-07-26T12:00:00.000Z"),
		launchGraceSeconds: 1,
	});
	assert.equal(events[0]?.failureReason, "never_started");
	assert.equal(events[0]?.retryTaskId, undefined);
	assert.equal(events[0]?.retrySkipped, "brief_missing");

	const loaded = await loadBgTask(root, id);
	assert.equal(loaded?.record.retrySkipped, "brief_missing");
	assert.equal(loaded?.record.retryTaskId, undefined);

	// No new task record was created.
	const after = await readdirSafe(dir);
	const newFiles = after.filter((f) => !before.includes(f));
	assert.deepEqual(
		newFiles.filter((f) => f.endsWith(".md")),
		[],
	);
});
