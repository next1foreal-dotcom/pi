/**
 * G-356 — spawn-layer probe gate for external CLI workers, plus probe_max_age_hours.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseTasksPublish } from "../src/her-core/bg-task-config.ts";
import { type BgTaskRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import {
	assertFreshExternalCliProbe,
	CHANNEL_PROBE_REMEDY,
	EXTERNAL_CLI_SET,
} from "../src/her-core/channel-probe-gate.ts";
import { workerCliName } from "../src/her-core/worker-profile.ts";

const REMEDY = "node packages/her/scripts/probe-worker-channels.mjs --write-latest";
const NOW = new Date("2026-08-31T12:00:00.000Z");
const FAKE_GROK = join("Z:", "g356-missing", "grok.cmd");

async function memoryRoot(config: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g356-"));
	await mkdir(tasksDir(root), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), config, "utf8");
	return root;
}

function grokWorkerYaml(over?: { probeMaxAgeHours?: number }): string {
	const lines = [
		"workers:",
		"  grok_build:",
		`    argv: ["${FAKE_GROK.replace(/\\/g, "/")}", "--always-approve"]`,
		"  fake:",
		`    argv: ["${process.execPath.replace(/\\/g, "/")}", "-e", "process.exit(0)"]`,
		"tasks:",
		"  budget_daily_cap: 999",
	];
	if (over?.probeMaxAgeHours !== undefined) {
		lines.push(`  probe_max_age_hours: ${over.probeMaxAgeHours}`);
	}
	lines.push("");
	return lines.join("\n");
}

async function writeProbe(
	repoRoot: string,
	body: {
		at: string;
		channels: Array<{ name: string; alive: boolean; version: string | null; error: string | null; quota: string }>;
	},
): Promise<void> {
	await mkdir(join(repoRoot, "ops"), { recursive: true });
	await writeFile(join(repoRoot, "ops", "channel-probe-latest.json"), `${JSON.stringify(body)}\n`, "utf8");
}

function aliveRow(name: string, alive = true) {
	return { name, alive, version: alive ? "1.0" : null, error: alive ? null : "dead", quota: "unknown" };
}

test("G-356 workerCliName strips Windows shim suffixes and EXTERNAL_CLI_SET is the four CLIs", () => {
	assert.equal(workerCliName("grok.cmd"), "grok");
	assert.equal(workerCliName("grok.exe"), "grok");
	assert.equal(workerCliName("cursor-agent.cmd"), "cursor-agent");
	assert.deepEqual([...EXTERNAL_CLI_SET].sort(), ["claude", "codex", "cursor-agent", "grok"]);
});

test("G-356 parseTasksPublish reads probe_max_age_hours", () => {
	const parsed = parseTasksPublish("tasks:\n  probe_max_age_hours: 6\n");
	assert.equal(parsed.tasks?.probeMaxAgeHours, 6);
	const zero = parseTasksPublish("tasks:\n  probe_max_age_hours: 0\n");
	assert.equal(zero.tasks?.probeMaxAgeHours, 0);
});

test("G-356 gate: missing archive throws 缺档 with the remedy command", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-missing-"));
	assert.throws(
		() =>
			assertFreshExternalCliProbe({
				cliName: "grok",
				maxAgeHours: 24,
				repoRoot: repo,
				now: NOW,
			}),
		(err: Error) => {
			assert.match(err.message, /缺档/);
			assert.match(err.message, new RegExp(REMEDY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.equal(err.message.includes(CHANNEL_PROBE_REMEDY), true);
			return true;
		},
	);
});

test("G-356 gate: expired archive throws 过期 N 小时 with the remedy command", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-stale-"));
	await writeProbe(repo, {
		at: "2026-08-29T12:00:00.000Z",
		channels: [aliveRow("grok")],
	});
	assert.throws(
		() =>
			assertFreshExternalCliProbe({
				cliName: "grok",
				maxAgeHours: 24,
				repoRoot: repo,
				now: NOW,
			}),
		(err: Error) => {
			assert.match(err.message, /过期 48 小时/);
			assert.match(err.message, new RegExp(REMEDY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			return true;
		},
	);
});

test("G-356 gate: channel dead throws 该通道 dead with the remedy command", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-dead-"));
	await writeProbe(repo, {
		at: NOW.toISOString(),
		channels: [aliveRow("grok", false)],
	});
	assert.throws(
		() =>
			assertFreshExternalCliProbe({
				cliName: "grok",
				maxAgeHours: 24,
				repoRoot: repo,
				now: NOW,
			}),
		(err: Error) => {
			assert.match(err.message, /该通道 dead/);
			assert.match(err.message, /grok/);
			assert.match(err.message, new RegExp(REMEDY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			return true;
		},
	);
});

test("G-356 gate: fresh and alive passes", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-ok-"));
	await writeProbe(repo, {
		at: NOW.toISOString(),
		channels: [aliveRow("grok"), aliveRow("codex")],
	});
	assert.doesNotThrow(() =>
		assertFreshExternalCliProbe({
			cliName: "grok",
			maxAgeHours: 24,
			repoRoot: repo,
			now: NOW,
		}),
	);
});

test("G-356 gate: probe_max_age_hours 0 skips even when the archive is missing", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-off-"));
	assert.doesNotThrow(() =>
		assertFreshExternalCliProbe({
			cliName: "grok",
			maxAgeHours: 0,
			repoRoot: repo,
			now: NOW,
		}),
	);
});

test("G-356 gate: non-external cli names are not gated", async () => {
	const repo = await mkdtemp(join(tmpdir(), "g356-probe-node-"));
	assert.doesNotThrow(() =>
		assertFreshExternalCliProbe({
			cliName: "node",
			maxAgeHours: 24,
			repoRoot: repo,
			now: NOW,
		}),
	);
	assert.doesNotThrow(() =>
		assertFreshExternalCliProbe({
			cliName: workerCliName("panel-chair"),
			maxAgeHours: 24,
			repoRoot: repo,
			now: NOW,
		}),
	);
});

test("G-356 spawn worker grok with missing archive throws 缺档 before any task residual", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-missing-"));
	await assert.rejects(
		() =>
			spawnBgTask(root, {
				objective: "g356 missing",
				worker: "grok_build",
				brief: "do not launch",
				skipGates: true,
				probeRepoRoot: probeRoot,
			}),
		(err: Error) => {
			assert.match(err.message, /缺档/);
			assert.match(err.message, new RegExp(REMEDY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			return true;
		},
	);
	const leftover = await readdir(tasksDir(root));
	assert.deepEqual(
		leftover.filter((name) => name.endsWith(".md") || name.endsWith(".brief") || name.endsWith(".pid")),
		[],
	);
});

test("G-356 spawn worker grok with dead channel throws 该通道 dead", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-dead-"));
	await writeProbe(probeRoot, { at: NOW.toISOString(), channels: [aliveRow("grok", false)] });
	await assert.rejects(
		() =>
			spawnBgTask(root, {
				objective: "g356 dead",
				worker: "grok_build",
				brief: "do not launch",
				skipGates: true,
				probeRepoRoot: probeRoot,
			}),
		/该通道 dead/,
	);
});

test("G-356 spawn worker grok with expired archive throws 过期", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-stale-"));
	await writeProbe(probeRoot, {
		at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
		channels: [aliveRow("grok")],
	});
	await assert.rejects(
		() =>
			spawnBgTask(root, {
				objective: "g356 stale",
				worker: "grok_build",
				brief: "do not launch",
				skipGates: true,
				probeRepoRoot: probeRoot,
			}),
		/过期 \d+ 小时/,
	);
});

test("G-356 spawn worker grok fresh and alive is not rejected by the probe gate", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-ok-"));
	await writeProbe(probeRoot, { at: new Date().toISOString(), channels: [aliveRow("grok")] });
	const result = await spawnBgTask(root, {
		objective: "g356 ok",
		worker: "grok_build",
		brief: "do not hang",
		skipGates: true,
		probeRepoRoot: probeRoot,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status === "running") {
		const { stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
		await stopBgTask(root, result.id);
	}
});

test("G-356 spawn probe_max_age_hours 0 does not throw on missing archive", async () => {
	const root = await memoryRoot(grokWorkerYaml({ probeMaxAgeHours: 0 }));
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-off-"));
	const result = await spawnBgTask(root, {
		objective: "g356 off",
		worker: "grok_build",
		brief: "gate off",
		skipGates: true,
		probeRepoRoot: probeRoot,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status === "running") {
		const { stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
		await stopBgTask(root, result.id);
	}
});

test("G-356 spawn non-external worker is not probe-gated", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-fake-"));
	const result = await spawnBgTask(root, {
		objective: "g356 fake",
		worker: "fake",
		brief: "ok",
		skipGates: true,
		probeRepoRoot: probeRoot,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status === "running") {
		const { stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
		await stopBgTask(root, result.id);
	}
});

test("G-356 spawn bare command is not probe-gated", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const probeRoot = await mkdtemp(join(tmpdir(), "g356-spawn-bare-"));
	const result = await spawnBgTask(root, {
		objective: "g356 bare",
		command: [process.execPath, "-e", "process.exit(0)"],
		skipGates: true,
		probeRepoRoot: probeRoot,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status === "running") {
		const { stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
		await stopBgTask(root, result.id);
	}
});

test("G-356 pendingTaskId launch is not probe-gated", async () => {
	const root = await memoryRoot(grokWorkerYaml());
	const id = "t-20260831-pendg356";
	const record: BgTaskRecord = {
		id,
		status: "pending",
		objective: "pending grok",
		worker: "grok_build",
		mode: "worker",
		command: [FAKE_GROK, "--always-approve"],
		created: "2026-08-31T00:00:00.000Z",
		updated: "2026-08-31T00:00:00.000Z",
		retries: 0,
		host: hostname(),
	};
	await saveBgTask(root, record, "# pending\n");
	const result = await spawnBgTask(root, { pendingTaskId: id });
	assert.ok(result.status === "running" || result.status === "failed");
	if (result.status === "running") {
		const { stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
		await stopBgTask(root, result.id);
	}
});
