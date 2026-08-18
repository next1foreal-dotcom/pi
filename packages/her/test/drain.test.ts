import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import {
	clampDrainTtlMinutes,
	drainFlagPath,
	readDrainState,
	startDrain,
	stopDrain,
	waitForQuiet,
} from "../src/her-core/drain.ts";
import { eventHistoryPath, listHerEvents } from "../src/her-core/event-history.ts";
import { initStore } from "../src/her-core/index.ts";

interface CliResult {
	code: number;
	stderr: string;
	stdout: string;
}

async function tempMemory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g275-"));
	await initStore(root);
	return root;
}

async function runDrain(args: string[], memoryDir: string, extra: NodeJS.ProcessEnv = {}): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	const io = {
		stderr: {
			write(chunk: string) {
				stderr += chunk;
				return true;
			},
		},
		stdout: {
			write(chunk: string) {
				stdout += chunk;
				return true;
			},
		},
	};
	const env: NodeJS.ProcessEnv = { ...process.env, HER_MEMORY_DIR: memoryDir, ...extra };
	const code = await runHerCli(args, env, memoryDir, io as never);
	return { code, stderr, stdout };
}

function parseJson(text: string): Record<string, unknown> {
	return JSON.parse(text) as Record<string, unknown>;
}

test("no drain flag reads as inactive", async () => {
	const root = await tempMemory();
	const state = await readDrainState(root);
	assert.equal(state.active, false);
	const status = await runDrain(["drain-status", "--json"], root);
	assert.equal(status.code, 0, status.stderr);
	const payload = parseJson(status.stdout);
	assert.equal(payload.active, false);
	assert.equal(payload.remainingSeconds, 0);
});

test("drain-start writes flag, event, and status; stop deletes flag with no event", async () => {
	const root = await tempMemory();
	const before = new Date();
	const started = await runDrain(
		["drain-start", "--reason", "deploy gateway", "--ttl-minutes", "30", "--by", "fei"],
		root,
	);
	assert.equal(started.code, 0, started.stderr);
	const raw = await readFile(drainFlagPath(root), "utf8");
	const flag = JSON.parse(raw) as { reason: string; by: string; startedAt: string; expiresAt: string };
	assert.equal(flag.reason, "deploy gateway");
	assert.equal(flag.by, "fei");
	const startedAt = Date.parse(flag.startedAt);
	const expiresAt = Date.parse(flag.expiresAt);
	assert.equal(Number.isNaN(startedAt), false);
	assert.equal(Number.isNaN(expiresAt), false);
	assert.ok(flag.startedAt.endsWith("Z"));
	assert.ok(flag.expiresAt.endsWith("Z"));
	assert.ok(startedAt >= before.getTime() - 1000);
	assert.ok(Math.abs(expiresAt - startedAt - 30 * 60_000) < 2000);

	const events = await listHerEvents(root, { kind: "host.restart_planned" });
	assert.equal(events.length, 1);
	assert.equal(events[0].kind, "host.restart_planned");
	assert.equal(events[0].actor, "drain-cli");
	const data = events[0].data as { reason: string; ttlMinutes: number; by: string; source: string };
	assert.equal(data.reason, "deploy gateway");
	assert.equal(data.ttlMinutes, 30);
	assert.equal(data.by, "fei");
	assert.equal(data.source, "drain");

	const status = await runDrain(["drain-status", "--json"], root);
	assert.equal(status.code, 0, status.stderr);
	const payload = parseJson(status.stdout);
	assert.equal(payload.active, true);
	assert.equal(payload.reason, "deploy gateway");
	assert.equal(payload.expiresAt, flag.expiresAt);
	assert.equal(typeof payload.remainingSeconds, "number");
	assert.ok((payload.remainingSeconds as number) > 0);

	const stopped = await runDrain(["drain-stop"], root);
	assert.equal(stopped.code, 0, stopped.stderr);
	assert.match(stopped.stdout, /active|existed|stopped/i);
	await assert.rejects(() => readFile(drainFlagPath(root), "utf8"));
	const afterStop = await listHerEvents(root);
	assert.equal(afterStop.length, 1, "drain-stop must not append an event");
	const missing = await runDrain(["drain-stop"], root);
	assert.equal(missing.code, 0, missing.stderr);
});

test("drain-start overwrites an active flag and warns", async () => {
	const root = await tempMemory();
	const first = await runDrain(["drain-start", "--reason", "first", "--by", "a"], root);
	assert.equal(first.code, 0, first.stderr);
	const second = await runDrain(["drain-start", "--reason", "second", "--ttl-minutes", "15", "--by", "b"], root);
	assert.equal(second.code, 0, second.stderr);
	assert.match(second.stderr, /warn/i);
	const flag = JSON.parse(await readFile(drainFlagPath(root), "utf8")) as { reason: string; by: string };
	assert.equal(flag.reason, "second");
	assert.equal(flag.by, "b");
	const events = await listHerEvents(root, { kind: "host.restart_planned" });
	assert.equal(events.length, 2);
});

test("expired drain flag reads as inactive with a warning", async () => {
	const root = await tempMemory();
	await mkdir(join(root, ".her"), { recursive: true });
	await writeFile(
		drainFlagPath(root),
		`${JSON.stringify({
			reason: "stale",
			by: "ops",
			startedAt: "2020-01-01T00:00:00.000Z",
			expiresAt: "2020-01-01T00:30:00.000Z",
		})}\n`,
	);
	const state = await readDrainState(root);
	assert.equal(state.active, false);
	assert.match(state.warning ?? "", /expir/i);
	const status = await runDrain(["drain-status", "--json"], root);
	assert.equal(status.code, 0, status.stderr);
	assert.equal(parseJson(status.stdout).active, false);
	assert.match(status.stderr, /expir/i);
});

test("corrupt drain flag reads as inactive with a warning", async () => {
	const root = await tempMemory();
	await mkdir(join(root, ".her"), { recursive: true });
	await writeFile(drainFlagPath(root), "not-json{\n");
	const badJson = await readDrainState(root);
	assert.equal(badJson.active, false);
	assert.match(badJson.warning ?? "", /invalid|corrupt/i);

	await writeFile(drainFlagPath(root), `${JSON.stringify({ reason: "only-reason" })}\n`);
	const missingFields = await readDrainState(root);
	assert.equal(missingFields.active, false);
	assert.match(missingFields.warning ?? "", /invalid|corrupt/i);

	const status = await runDrain(["drain-status"], root);
	assert.equal(status.code, 0, status.stderr);
	assert.match(status.stderr, /invalid|corrupt/i);
});

test("TTL default 30, cap 240, illegal values fall back with a warning", () => {
	assert.deepEqual(clampDrainTtlMinutes(undefined), { ttlMinutes: 30 });
	assert.equal(clampDrainTtlMinutes(15).ttlMinutes, 15);
	assert.equal(clampDrainTtlMinutes(240).ttlMinutes, 240);
	const capped = clampDrainTtlMinutes(400);
	assert.equal(capped.ttlMinutes, 240);
	assert.match(capped.warning ?? "", /240/);
	const zero = clampDrainTtlMinutes(0);
	assert.equal(zero.ttlMinutes, 30);
	assert.match(zero.warning ?? "", /default|invalid/i);
	const nan = clampDrainTtlMinutes(Number.NaN);
	assert.equal(nan.ttlMinutes, 30);
	assert.match(nan.warning ?? "", /default|invalid/i);
});

test("drain-start clamps illegal TTL and warns", async () => {
	const root = await tempMemory();
	const illegal = await runDrain(["drain-start", "--reason", "x", "--ttl-minutes", "-3"], root);
	assert.equal(illegal.code, 0, illegal.stderr);
	assert.match(illegal.stderr, /default|invalid|ttl/i);
	const flag = JSON.parse(await readFile(drainFlagPath(root), "utf8")) as { startedAt: string; expiresAt: string };
	assert.ok(Math.abs(Date.parse(flag.expiresAt) - Date.parse(flag.startedAt) - 30 * 60_000) < 2000);
});

test("drain-wait: no running tasks exits 0; injected running task times out with exit 2", async () => {
	const root = await tempMemory();
	const quiet = await waitForQuiet({
		memoryDir: root,
		timeoutSeconds: 1,
		pollIntervalMs: 1,
		listBgTasks: async () => [],
	});
	assert.equal(quiet.ok, true);
	assert.ok(quiet.elapsedSeconds >= 0);

	const cliQuiet = await runDrain(["drain-wait", "--timeout-seconds", "1", "--json"], root);
	assert.equal(cliQuiet.code, 0, cliQuiet.stderr);
	assert.equal(parseJson(cliQuiet.stdout).ok, true);

	const timed = await waitForQuiet({
		memoryDir: root,
		timeoutSeconds: 1,
		pollIntervalMs: 1,
		listBgTasks: async () => [{ id: "bg-1", status: "running" }],
	});
	assert.equal(timed.ok, false);
	assert.equal(timed.running.length, 1);
	assert.equal(timed.running[0].id, "bg-1");
});

test("notify failure warns and does not change exit code", async () => {
	const root = await tempMemory();
	const sent: string[] = [];
	await startDrain({
		memoryDir: root,
		reason: "deploy",
		by: "fei",
		notify: true,
		sendNotify: async (text) => {
			sent.push(text);
			throw new Error("tg down");
		},
	});
	assert.equal(sent.length, 1);

	const cli = await runDrain(["drain-start", "--reason", "n", "--notify"], root, {
		HER_TELEGRAM_BOT_TOKEN: "",
		HER_TELEGRAM_CHAT_ID: "",
	});
	assert.equal(cli.code, 0, cli.stderr);
	assert.match(cli.stderr, /warn|telegram|notify/i);

	const stop = await stopDrain({
		memoryDir: root,
		notify: true,
		sendNotify: async () => {
			throw new Error("tg down");
		},
	});
	assert.equal(stop.existed, true);
});

test("EVENT_KINDS is unchanged: drain reuses host.restart_planned", async () => {
	const root = await tempMemory();
	await startDrain({ memoryDir: root, reason: "x", by: "t" });
	const raw = await readFile(eventHistoryPath(root), "utf8");
	assert.match(raw, /"kind":"host.restart_planned"/);
	assert.doesNotMatch(raw, /drain_start|drain.start/);
});
