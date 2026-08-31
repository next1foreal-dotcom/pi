import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearPresence,
	formatPresenceLine,
	joinPresence,
	readPresenceMap,
	recordPresence,
} from "../src/her-core/presence.ts";

async function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "her-g367-presence-"));
}

function presenceFile(root: string, sessionId: string): string {
	return join(root, "presence", `${sessionId}.json`);
}

async function spawnExitedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	if (pid === undefined) throw new Error("spawn produced no pid");
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve());
	});
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			await new Promise((resolve) => setTimeout(resolve, 20));
		} catch {
			return pid;
		}
	}
	throw new Error(`pid ${pid} still appears alive after exit`);
}

test("recordPresence / readPresenceMap / clearPresence round-trip a live pid row", async () => {
	const root = await tempRoot();
	const sessionId = "pi-session-0001";
	await recordPresence(root, { sessionId, pid: process.pid, mode: "tui", state: "idle" });
	const map = await readPresenceMap(root);
	const row = map.get(sessionId);
	assert.ok(row);
	assert.equal(row.pid, process.pid);
	assert.equal(row.mode, "tui");
	assert.equal(row.state, "idle");
	assert.equal(typeof row.at, "string");
	assert.equal(typeof row.startedAt, "string");
	assert.equal(row.at, row.startedAt);
	const raw = JSON.parse(await readFile(presenceFile(root, sessionId), "utf8")) as {
		pid: number;
		mode: string;
		state: string;
	};
	assert.equal(raw.pid, process.pid);
	assert.equal(raw.mode, "tui");
	assert.equal(raw.state, "idle");
	await clearPresence(root, sessionId);
	assert.equal((await readPresenceMap(root)).has(sessionId), false);
	await assert.rejects(() => readFile(presenceFile(root, sessionId), "utf8"), { code: "ENOENT" });
	await clearPresence(root, sessionId);
});

test("recordPresence keeps startedAt when state is overwritten", async () => {
	const root = await tempRoot();
	const sessionId = "pi-session-startedAt";
	await recordPresence(root, { sessionId, pid: process.pid, mode: "tui", state: "idle" });
	const first = JSON.parse(await readFile(presenceFile(root, sessionId), "utf8")) as {
		at: string;
		startedAt: string;
		state: string;
	};
	await new Promise((resolve) => setTimeout(resolve, 15));
	await recordPresence(root, { sessionId, pid: process.pid, mode: "print", state: "busy" });
	const second = JSON.parse(await readFile(presenceFile(root, sessionId), "utf8")) as {
		at: string;
		mode: string;
		pid: number;
		startedAt: string;
		state: string;
	};
	assert.equal(second.startedAt, first.startedAt);
	assert.equal(second.state, "busy");
	assert.equal(second.mode, "print");
	assert.equal(second.pid, process.pid);
	const mapped = (await readPresenceMap(root)).get(sessionId);
	assert.equal(mapped?.startedAt, first.startedAt);
	assert.equal(mapped?.state, "busy");
});

test("readPresenceMap self-heals a dead pid row (unlink + omit from map)", async () => {
	const root = await tempRoot();
	const sessionId = "pi-session-dead";
	const deadPid = await spawnExitedPid();
	await recordPresence(root, { sessionId, pid: deadPid, mode: "tui", state: "idle" });
	assert.equal(typeof JSON.parse(await readFile(presenceFile(root, sessionId), "utf8")).pid, "number");
	const map = await readPresenceMap(root);
	assert.equal(map.has(sessionId), false);
	assert.equal(map.size, 0);
	await assert.rejects(() => readFile(presenceFile(root, sessionId), "utf8"), { code: "ENOENT" });
});

test("readPresenceMap deletes bad JSON and skips the row", async () => {
	const root = await tempRoot();
	const sessionId = "pi-session-badjson";
	await mkdir(join(root, "presence"), { recursive: true });
	await writeFile(presenceFile(root, sessionId), "{not-json", "utf8");
	await writeFile(join(root, "presence", "not-a-row.txt"), "ignore", "utf8");
	const map = await readPresenceMap(root);
	assert.equal(map.has(sessionId), false);
	await assert.rejects(() => readFile(presenceFile(root, sessionId), "utf8"), { code: "ENOENT" });
	const leftover = await readdir(join(root, "presence"));
	assert.deepEqual(leftover, ["not-a-row.txt"]);
});

test("joinPresence merges presence onto pi rows and leaves other sources untouched", () => {
	const at = "2026-08-31T12:00:00.000Z";
	const map = new Map([["pi-live", { pid: 4242, mode: "tui", state: "busy" as const, at, startedAt: at }]]);
	const rows = [
		{ id: "pi-live", source: "pi", project: "alpha" },
		{ id: "pi-gone", source: "pi", project: "beta" },
		{ id: "claude-1", source: "claude", project: "gamma" },
	];
	const originalClaude = rows[2];
	const joined = joinPresence(rows, map);
	assert.deepEqual(joined[0], { id: "pi-live", source: "pi", project: "alpha", alive: true, state: "busy" });
	assert.deepEqual(joined[1], { id: "pi-gone", source: "pi", project: "beta", alive: false });
	assert.deepEqual(joined[2], { id: "claude-1", source: "claude", project: "gamma" });
	assert.equal(joined[2], originalClaude);
	assert.equal("alive" in (joined[2] as { alive?: unknown }), false);
});

test("formatPresenceLine lists alive rows as compact live: text", () => {
	const joined = [
		{ id: "her-dc", source: "pi", alive: true as const, state: "idle" as const },
		{ id: "her-bd", source: "pi", alive: true as const, state: "busy" as const },
		{ id: "pi-gone", source: "pi", alive: false as const },
		{ id: "claude-1", source: "claude" },
	];
	assert.equal(formatPresenceLine(joined), "live: her-dc idle · her-bd busy");
});

test("formatPresenceLine returns empty string when no row is alive", () => {
	assert.equal(
		formatPresenceLine([
			{ id: "pi-gone", source: "pi", alive: false as const },
			{ id: "claude-1", source: "claude" },
		]),
		"",
	);
	assert.equal(formatPresenceLine([]), "");
});
