/**
 * G-185/S5 — deer ownership bridge + cross-path dedupe.
 * The S1/S1b ownership tests live in bg-task-owner.test.ts; this file covers the
 * envelope/env plumbing and the "Studio already told her" verdict.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { loadExternalDeliveries, matchExternalDeliveries } from "../src/her-core/bg-task-owner.ts";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import { type BgTaskRecord, loadBgTask, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { spawnBgTask } from "../src/her-core/bg-task-spawn.ts";
import { applyDeerWorkflowEvent, createDeerBridgeState } from "../src/her-core/deer-workflow-bridge.ts";
import {
	type HerRunSnapshot,
	type HerWakeLedgerRow,
	listHerRunSnapshots,
	runsWakeLedgerPath,
} from "../src/her-core/runs.ts";
import { buildWorkerEnv } from "../src/her-core/worker-profile.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const STALE = "2026-08-02T11:30:00.000Z"; // 30 min ago — past the owner grace window
const OWNER = "workspace-A";
const RUNNER_TS = join(process.cwd(), "packages", "her", "src", "her-core", "deer-workflow-runner.ts");

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g185-s5-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  budget_daily_cap: 999\n", "utf8");
	return root;
}

function baseRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "completed",
		objective: "deer run",
		worker: "deer",
		command: ["node"],
		created: STALE,
		updated: STALE,
		endedAt: STALE,
		retries: 0,
		host: "THIS-BOX",
		...rest,
		id,
	};
}

function snapshot(over: Partial<HerRunSnapshot> & { runId: string }): HerRunSnapshot {
	return {
		status: "done",
		kind: "workflow",
		source: "deer-workflow",
		title: "t",
		startedAt: STALE,
		updatedAt: STALE,
		...over,
	};
}

function ledgerRow(over: Partial<HerWakeLedgerRow> & { wakeId: string }): HerWakeLedgerRow {
	return {
		terminalStatus: "done",
		deliveredAt: STALE,
		deliveredBy: "server-watcher",
		...over,
	};
}

/**
 * Run the real deer runner to completion. stdin MUST be written and closed — the runner
 * blocks on stdin EOF, so a pipe left open hangs the process (and the test) forever.
 */
async function runDeerRunner(env: NodeJS.ProcessEnv, brief: string): Promise<void> {
	await new Promise<void>((done) => {
		const child = spawn(process.execPath, ["--import", "tsx", RUNNER_TS], {
			env,
			cwd: process.cwd(),
			stdio: ["pipe", "ignore", "ignore"],
			windowsHide: true,
		});
		const guard = setTimeout(() => child.kill(), 60_000);
		const finish = () => {
			clearTimeout(guard);
			done();
		};
		child.on("error", finish);
		child.on("close", finish);
		child.stdin?.end(brief);
	});
}

async function writeLedger(root: string, rows: HerWakeLedgerRow[]): Promise<void> {
	await mkdir(join(root, "runs"), { recursive: true });
	await writeFile(runsWakeLedgerPath(root), rows.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
}

/** One terminal deer run in the envelope, joined to `bgTaskId`. */
async function writeDeerRun(root: string, runId: string, bgTaskId: string): Promise<void> {
	await mkdir(join(root, "runs"), { recursive: true });
	await writeFile(
		join(root, "runs", "events.jsonl"),
		`${JSON.stringify({
			type: "run",
			runId,
			status: "done",
			kind: "workflow",
			source: "deer-workflow",
			title: "t",
			at: STALE,
			ownerWorkspaceId: OWNER,
			bgTaskId,
		})}\n`,
		"utf8",
	);
}

// S5-1 — the env channel: ownership is injected, and omitted entirely when ownerless.
test("S5-1 buildWorkerEnv injects HER_TASK_OWNER_SESSION_ID only when owned", () => {
	const owned = buildWorkerEnv({ argv: ["node"] }, "t-1", OWNER);
	assert.equal(owned.HER_TASK_ID, "t-1");
	assert.equal(owned.HER_TASK_OWNER_SESSION_ID, OWNER);

	const anon = buildWorkerEnv({ argv: ["node"] }, "t-1");
	assert.equal(anon.HER_TASK_ID, "t-1");
	assert.equal("HER_TASK_OWNER_SESSION_ID" in anon, false, "ownerless worker env must not carry the key");
});

// S5-2 — bridge patches carry both fields; an ownerless run is byte-identical to the old shape.
test("S5-2 deer bridge patches carry ownerWorkspaceId + bgTaskId", () => {
	const state = createDeerBridgeState({ runId: "deer-1", ownerWorkspaceId: OWNER, bgTaskId: "t-42" });
	const { patch } = applyDeerWorkflowEvent(state, { type: "workflow:start", timestamp: STALE });
	assert.equal(patch?.ownerWorkspaceId, OWNER);
	assert.equal(patch?.bgTaskId, "t-42");
	// The wake display id must stay the runId — folding the owner into piSessionId would make
	// every task of one session share a single wake identity.
	assert.equal(patch?.piSessionId, undefined);

	const anonState = createDeerBridgeState({ runId: "deer-2" });
	const anon = applyDeerWorkflowEvent(anonState, { type: "workflow:start", timestamp: STALE });
	assert.equal("ownerWorkspaceId" in (anon.patch ?? {}), false);
	assert.equal("bgTaskId" in (anon.patch ?? {}), false);
});

// S5-3 — the join, in all the shapes the two writers actually produce.
test("S5-3 matchExternalDeliveries: watcher rows join on runId, browser rows on wakeId", () => {
	const runs = [
		snapshot({ runId: "deer-1", bgTaskId: "t-1" }),
		snapshot({ runId: "deer-2", bgTaskId: "t-2" }),
		snapshot({ runId: "deer-3", bgTaskId: "t-3" }),
		snapshot({ runId: "deer-4" }), // no bgTaskId — unjoinable, must never match
	];
	const delivered = matchExternalDeliveries(runs, [
		ledgerRow({ wakeId: "deer-1", runId: "deer-1" }), // watcher row
		ledgerRow({ wakeId: "deer-2", deliveredBy: "browser" }), // browser row: wakeId only
		ledgerRow({ wakeId: "deer-3", runId: "deer-3", failed: true }), // gave up → NOT delivered
		ledgerRow({ wakeId: "deer-4", runId: "deer-4" }),
	]);
	assert.deepEqual([...delivered].sort(), ["t-1", "t-2"]);
});

// S5-4 external 三态 — ledger says delivered / says failed / has no file at all.
test("S5-4 takeover becomes external only for a real delivery", async () => {
	// ① 已送达 → external: 盖章、不产事件
	const delivered = await memoryRoot();
	await saveBgTask(delivered, baseRecord({ id: "t-ext", ownerSessionId: OWNER }), "# x\n");
	await writeDeerRun(delivered, "deer-ext", "t-ext");
	await writeLedger(delivered, [ledgerRow({ wakeId: "deer-ext", runId: "deer-ext" })]);
	const externalEvents = await reconcileBgTasks(delivered, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.deepEqual(externalEvents, [], "Studio already reported it — pi must stay quiet");
	assert.ok((await loadBgTask(delivered, "t-ext"))?.record.notifiedAt, "…but the record is still settled");

	// ② failed 行 = 值守放弃了 = 根本没人被告知 → 照常代送
	const gaveUp = await memoryRoot();
	await saveBgTask(gaveUp, baseRecord({ id: "t-ext", ownerSessionId: OWNER }), "# x\n");
	await writeDeerRun(gaveUp, "deer-ext", "t-ext");
	await writeLedger(gaveUp, [ledgerRow({ wakeId: "deer-ext", runId: "deer-ext", failed: true })]);
	const gaveUpEvents = await reconcileBgTasks(gaveUp, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.equal(gaveUpEvents.length, 1);
	assert.equal(gaveUpEvents[0]?.takenOver, true);

	// ③ 没有账本文件 → takeover 照旧
	const noLedger = await memoryRoot();
	await saveBgTask(noLedger, baseRecord({ id: "t-ext", ownerSessionId: OWNER }), "# x\n");
	const plainEvents = await reconcileBgTasks(noLedger, { hostname: "THIS-BOX", now: NOW, sessionId: "session-B" });
	assert.equal(plainEvents.length, 1);
	assert.equal(plainEvents[0]?.takenOver, true);
	assert.deepEqual(await loadExternalDeliveries(noLedger), new Set());
});

// S5-5 — external must not steal the owner's own wake: inside the grace window the owner
// still gets its event even when Studio has a row (defer/own outrank the ledger check).
test("S5-5 an external delivery never suppresses the owner's own claim", async () => {
	const root = await memoryRoot();
	await saveBgTask(root, baseRecord({ id: "t-own", ownerSessionId: OWNER }), "# x\n");
	await writeDeerRun(root, "deer-own", "t-own");
	await writeLedger(root, [ledgerRow({ wakeId: "deer-own", runId: "deer-own" })]);
	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: OWNER });
	assert.equal(events.length, 1, "owner 自己认领不查外部账本");
});

// S5-6 实机 — a real worker child, spawned through the real spawnBgTask path, must actually
// see HER_TASK_OWNER_SESSION_ID. launchTask strips inherited HER_TASK_* keys, so this is the
// test that catches the env channel being silently dropped.
test("S5-6 a real worker child receives HER_TASK_OWNER_SESSION_ID", async () => {
	const root = await memoryRoot();
	const fixture = join(root, "print-owner.mjs");
	await writeFile(
		fixture,
		[
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			// Concatenation, not a template literal: a `${...}` inside this plain string would
			// trip biome's noTemplateCurlyInString on the *test* file.
			"  const owner = process.env.HER_TASK_OWNER_SESSION_ID || '(unset)';",
			"  const task = process.env.HER_TASK_ID || '(unset)';",
			"  process.stdout.write('OWNER=' + owner + '\\nTASK=' + task);",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"tasks:",
			"  budget_daily_cap: 999",
			"workers:",
			"  ownercheck:",
			`    argv: ["${process.execPath.replace(/\\/g, "/")}", "${fixture.replace(/\\/g, "/")}"]`,
			"",
		].join("\n"),
		"utf8",
	);

	const result = await spawnBgTask(root, {
		objective: "S5 env channel",
		worker: "ownercheck",
		brief: "x",
		ownerSessionId: OWNER,
		skipGates: true,
		heartbeatMs: 1000,
	});
	assert.equal(result.status, "running");
	if (result.status !== "running") return;

	const logPath = join(tasksDir(root), `${result.id}.log`);
	let log = "";
	for (let i = 0; i < 100 && !log.includes("TASK="); i += 1) {
		await sleep(100);
		log = await readFile(logPath, "utf8").catch(() => "");
	}
	assert.match(log, new RegExp(`OWNER=${OWNER}`), `worker child env must carry the owner; got: ${log}`);
	assert.match(log, new RegExp(`TASK=${result.id}`));
});

// S5-7 实机 — drive the real deer runner process with a real buildWorkerEnv env and watch the
// run envelope come out with both ownership fields on it. The deer CLI itself is absent here
// (HER_DEER_BUN points at nothing), which exercises the runner's failure-fallback event — the
// path that matters most, since a crashed workflow is exactly when the owner needs the report.
test("S5-7 the real deer runner writes ownerWorkspaceId + bgTaskId into runs/events.jsonl", async () => {
	const root = await memoryRoot();
	const env = buildWorkerEnv({ argv: ["node"], envAllow: ["HER_MEMORY_DIR", "HER_DEER_BUN"] }, "t-deer-1", OWNER);
	env.HER_MEMORY_DIR = root;
	env.HER_DEER_BUN = join(root, "no-such-bun.exe");

	// A non-zero exit is the point of this fixture — the deer CLI is deliberately missing.
	await runDeerRunner(env, JSON.stringify({ workflow: "does-not-matter.ts", runId: "deer-live-1", title: "live" }));

	const events = (await readFile(join(root, "runs", "events.jsonl"), "utf8")).trim().split("\n");
	const last = JSON.parse(events[events.length - 1] ?? "{}") as Record<string, unknown>;
	assert.equal(last.runId, "deer-live-1");
	assert.equal(last.status, "failed");
	assert.equal(last.ownerWorkspaceId, OWNER, "envelope must carry the owner,真值");
	assert.equal(last.bgTaskId, "t-deer-1", "envelope must carry the task id for the join");

	// …and it folds through the snapshot reader the dedupe join depends on.
	const snap = (await listHerRunSnapshots(root)).find((s) => s.runId === "deer-live-1");
	assert.equal(snap?.ownerWorkspaceId, OWNER);
	assert.equal(snap?.bgTaskId, "t-deer-1");
});

// S5-8 — ownerless deer runs keep the old envelope shape exactly (regression red line).
test("S5-8 an ownerless deer run writes the legacy envelope shape", async () => {
	const root = await memoryRoot();
	const env = buildWorkerEnv({ argv: ["node"], envAllow: ["HER_MEMORY_DIR", "HER_DEER_BUN"] }, "t-deer-2");
	env.HER_MEMORY_DIR = root;
	env.HER_DEER_BUN = join(root, "no-such-bun.exe");

	await runDeerRunner(env, JSON.stringify({ workflow: "does-not-matter.ts", runId: "deer-live-2" }));

	const raw = (await readFile(join(root, "runs", "events.jsonl"), "utf8")).trim();
	assert.doesNotMatch(raw, /ownerWorkspaceId/);
	// bgTaskId still rides along (HER_TASK_ID is set for every worker) — it is the join key,
	// not an ownership claim, and S3's watcher only ever acts on ownerWorkspaceId.
	assert.match(raw, /"bgTaskId":"t-deer-2"/);
});

// G-223R — a worker that cannot reach the public internet is a dead tier. The claude-tier
// worker died with `403 Request not allowed` because the env allowlist dropped the proxy
// vars; the identical command succeeded once they were restored (controlled probe).
test("G-223R buildWorkerEnv passes proxy settings through to the worker", () => {
	const saved = { ...process.env };
	try {
		process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
		process.env.NO_PROXY = "localhost,127.0.0.1";
		process.env.NODE_USE_ENV_PROXY = "1";
		const env = buildWorkerEnv({ argv: ["node"] }, "t-proxy");
		assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
		assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
		assert.equal(env.NODE_USE_ENV_PROXY, "1");
	} finally {
		process.env = saved;
	}
});
