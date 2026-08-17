import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import {
	appendEvent,
	eventHistoryPath,
	eventHistoryStatePath,
	readEventHistory,
} from "../src/her-core/event-history.ts";
import { initStore } from "../src/her-core/index.ts";

interface CliResult {
	code: number;
	stderr: string;
	stdout: string;
}

async function runSnap(args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()): Promise<CliResult> {
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
	const code = await runHerCli(args, env, cwd, io as never);
	return { code, stderr, stdout };
}

function envFor(memoryDir: string, snaps: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HER_MEMORY_DIR: memoryDir, HER_SNAPSHOT_DIR: snaps };
	delete env.FEI_RESTORE_CONFIRM;
	return env;
}

async function makeSource(): Promise<{ live: string; snaps: string; source: string }> {
	const source = await mkdtemp(join(tmpdir(), "her-g271-hsrc-"));
	const snaps = await mkdtemp(join(tmpdir(), "her-g271-hsnap-"));
	const live = await mkdtemp(join(tmpdir(), "her-g271-hlive-"));
	await initStore(source);
	await mkdir(join(live, ".her"), { recursive: true });
	await mkdir(join(source, ".git", "refs", "heads"), { recursive: true });
	await writeFile(join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
	await writeFile(join(source, ".git", "refs", "heads", "main"), `${"b".repeat(40)}\n`);
	return { live, snaps, source };
}

function snapshotPath(stdout: string): string {
	const match = stdout.match(/^snapshot: (.+)$/m);
	assert.ok(match, `expected snapshot path in stdout, got: ${stdout}`);
	return match[1].trim();
}

async function createSnap(source: string, snaps: string): Promise<string> {
	const created = await runSnap(["snapshot-create", "--same-volume-ok"], envFor(source, snaps));
	assert.equal(created.code, 0, created.stderr);
	return snapshotPath(created.stdout);
}

test("GIVEN snapshot then two new events WHEN restore THEN history keeps both sides and host.restore", async () => {
	const { source, snaps, live } = await makeSource();
	const before = [
		await appendEvent("host.run.start", "heartbeat", { runId: "pre-1" }, undefined, source),
		await appendEvent("host.run.end", "heartbeat", { runId: "pre-1", ok: true }, undefined, source),
	];
	await writeFile(join(source, "keep.txt"), "keep-v1\n");
	const snap = await createSnap(source, snaps);
	await writeFile(join(source, "keep.txt"), "keep-mutated\n");
	const after = [
		await appendEvent("host.run.start", "heartbeat", { runId: "post-1" }, undefined, source),
		await appendEvent("host.run.end", "heartbeat", { runId: "post-1", ok: true }, undefined, source),
	];
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(await readFile(join(source, "keep.txt"), "utf8"), "keep-v1\n");
	const { events } = await readEventHistory(source);
	const ids = events.map((event) => event.id);
	for (const event of [...before, ...after]) assert.equal(ids.includes(event.id), true, event.id);
	const last = events[events.length - 1];
	assert.equal(last.kind, "host.restore");
	assert.equal(last.actor, "snapshot-restore");
	assert.equal(typeof last.data?.snapshotTs, "string");
	assert.equal(last.data?.target, source);
});

test("id-merge: truncated current recovers snapshot-only events", async () => {
	const { source, snaps, live } = await makeSource();
	const first = await appendEvent("host.run.start", "heartbeat", { runId: "t1" }, undefined, source);
	const second = await appendEvent("host.run.end", "heartbeat", { runId: "t1", ok: true }, undefined, source);
	const snap = await createSnap(source, snaps);
	const raw = await readFile(eventHistoryPath(source), "utf8");
	const firstLine = raw.split("\n").filter((line) => line.length > 0)[0];
	await writeFile(eventHistoryPath(source), `${firstLine}\n`);
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	const { events } = await readEventHistory(source);
	const ids = events.map((event) => event.id);
	assert.equal(ids.includes(first.id), true);
	assert.equal(ids.includes(second.id), true);
	assert.equal(events[events.length - 1].kind, "host.restore");
	const coreIds = events.filter((event) => event.kind !== "host.restore").map((event) => event.id);
	assert.deepEqual([...coreIds].sort(), coreIds);
	assert.equal(new Set(ids).size, ids.length);
});

test("id-merge: current-only events after snapshot survive", async () => {
	const { source, snaps, live } = await makeSource();
	const pre = await appendEvent("host.run.start", "heartbeat", { runId: "c1" }, undefined, source);
	const snap = await createSnap(source, snaps);
	const extra = await appendEvent("host.run.end", "heartbeat", { runId: "c1", ok: true }, undefined, source);
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	const { events } = await readEventHistory(source);
	const ids = events.map((event) => event.id);
	assert.equal(ids.includes(pre.id), true);
	assert.equal(ids.includes(extra.id), true);
	assert.equal(events[events.length - 1].kind, "host.restore");
});

test("id-merge: disjoint unique events union by id order", async () => {
	const { source, snaps, live } = await makeSource();
	const shared = await appendEvent("host.run.start", "heartbeat", { runId: "d1" }, undefined, source);
	const snapOnly = await appendEvent("host.run.end", "heartbeat", { runId: "d1", ok: true }, undefined, source);
	const snap = await createSnap(source, snaps);
	const raw = await readFile(eventHistoryPath(source), "utf8");
	const firstLine = raw.split("\n").filter((line) => line.length > 0)[0];
	await writeFile(eventHistoryPath(source), `${firstLine}\n`);
	const currentOnly = await appendEvent("organ.round.start", "choice-model", { runId: "d2" }, undefined, source);
	const restored = await runSnap(["snapshot-restore", snap, source], envFor(live, snaps));
	assert.equal(restored.code, 0, restored.stderr);
	const { events } = await readEventHistory(source);
	const core = events.filter((event) => event.kind !== "host.restore");
	const ids = core.map((event) => event.id);
	assert.deepEqual([...ids].sort(), ids);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(ids.includes(shared.id), true);
	assert.equal(ids.includes(snapOnly.id), true);
	assert.equal(ids.includes(currentOnly.id), true);
	assert.equal(events[events.length - 1].kind, "host.restore");
	const state = JSON.parse(await readFile(eventHistoryStatePath(source), "utf8")) as {
		lastId: string;
		prefixLength: number;
		prefixSha256: string;
	};
	const bytes = await readFile(eventHistoryPath(source));
	assert.equal(state.prefixLength, bytes.byteLength);
	assert.equal(state.lastId, events[events.length - 1].id);
});
