import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runHerCli } from "../src/cli.ts";
import her from "../src/extension.ts";
import {
	appendEvent,
	detectPresumedCrashes,
	eventHistoryPath,
	listHerEvents,
	readEventHistory,
	uuidv7,
} from "../src/her-core/event-history.ts";
import { initStore } from "../src/her-core/index.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

const uuidv7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const workerPath = fileURLToPath(new URL("./event-history-append-worker.ts", import.meta.url));

async function tempMemory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g270-"));
	await initStore(root);
	return root;
}

async function withMemoryDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.HER_MEMORY_DIR;
		else process.env.HER_MEMORY_DIR = previous;
	}
}

async function readHistoryLines(root: string): Promise<string[]> {
	const raw = await readFile(eventHistoryPath(root), "utf8");
	return raw.split(/\n/).filter((line) => line.length > 0);
}

test("appendEvent writes one valid host.run.start line with uuidv7 and actor", async () => {
	const root = await tempMemory();
	await withMemoryDir(root, async () => {
		const event = await appendEvent("host.run.start", "heartbeat", { runId: "run-1" });
		assert.match(event.id, uuidv7Pattern);
		assert.equal(event.kind, "host.run.start");
		assert.equal(event.actor, "heartbeat");
		assert.equal(typeof event.ts, "string");
		assert.doesNotThrow(() => new Date(event.ts).toISOString());
		const lines = await readHistoryLines(root);
		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]) as typeof event;
		assert.equal(parsed.id, event.id);
		assert.equal(parsed.actor, "heartbeat");
		assert.equal((parsed.data as { runId: string }).runId, "run-1");
	});
});

test("appendEvent throws on missing actor or unknown kind and writes no row", async () => {
	const root = await tempMemory();
	await withMemoryDir(root, async () => {
		await assert.rejects(() => appendEvent("host.run.start", "", { runId: "x" }), /actor/);
		await assert.rejects(() => appendEvent("host.run.start", "   ", { runId: "x" }), /actor/);
		await assert.rejects(
			() => appendEvent("host.presumed_crash" as "host.run.start", "heartbeat", { runId: "x" }),
			/kind/,
		);
		await assert.rejects(async () => {
			await readFile(eventHistoryPath(root), "utf8");
		});
	});
});

test("1000 sequential appendEvent ids sort in write order including same-ms", { timeout: 120_000 }, async () => {
	const root = await tempMemory();
	await withMemoryDir(root, async () => {
		const ids: string[] = [];
		for (let i = 0; i < 1000; i++) {
			const event = await appendEvent("host.run.start", "heartbeat", { runId: `r-${i}` });
			ids.push(event.id);
		}
		assert.deepEqual([...ids].sort(), ids);
		assert.equal(new Set(ids).size, 1000);
		assert.ok(ids.every((id) => uuidv7Pattern.test(id)));
	});
});

test("two processes appending 200 lines each yield 400 intact JSONL rows", { timeout: 120_000 }, async () => {
	const root = await tempMemory();
	await Promise.all([spawnAppendWorker(root, 200, "heartbeat"), spawnAppendWorker(root, 200, "memory-sync")]);
	const raw = await readFile(eventHistoryPath(root), "utf8");
	assert.equal(raw.endsWith("\n"), true);
	const lines = raw.split("\n").filter((line) => line.length > 0);
	assert.equal(lines.length, 400);
	for (const line of lines) {
		const parsed = JSON.parse(line) as { id: string; actor: string };
		assert.match(parsed.id, uuidv7Pattern);
		assert.ok(parsed.actor === "heartbeat" || parsed.actor === "memory-sync");
	}
});

test("truncated tail yields prior events plus corrupt_tail; mid-file bad JSON yields corrupt_line", async () => {
	const root = await tempMemory();
	const first = await appendEvent("host.run.start", "heartbeat", { runId: "a" }, undefined, root);
	const second = await appendEvent("host.run.end", "heartbeat", { runId: "a", ok: true }, undefined, root);
	const path = eventHistoryPath(root);
	const intact = await readFile(path, "utf8");
	await writeFile(path, `${intact}{"id":"partial`, "utf8");
	const tailed = await readEventHistory(root);
	assert.equal(tailed.events.map((event) => event.id).join(","), `${first.id},${second.id}`);
	assert.equal(
		tailed.markers.some((marker) => marker.kind === "corrupt_tail"),
		true,
	);

	await writeFile(path, `${JSON.stringify(first)}\n{"not":"an event"\n${JSON.stringify(second)}\n`, "utf8");
	const mid = await readEventHistory(root);
	assert.deepEqual(
		mid.events.map((event) => event.id),
		[first.id, second.id],
	);
	assert.equal(
		mid.markers.some((marker) => marker.kind === "corrupt_line"),
		true,
	);
});

test("detectPresumedCrashes isolates actors and marks derived rows", async () => {
	const synthesizeStart = {
		id: uuidv7(),
		ts: "2026-08-17T00:00:00.000Z",
		kind: "organ.round.start" as const,
		actor: "synthesize",
		data: { runId: "syn-1" },
	};
	const consolidateStart = {
		id: uuidv7(),
		ts: "2026-08-17T00:00:01.000Z",
		kind: "organ.round.start" as const,
		actor: "consolidate",
		data: { runId: "con-1" },
	};
	const consolidateEnd = {
		id: uuidv7(),
		ts: "2026-08-17T00:00:02.000Z",
		kind: "organ.round.end" as const,
		actor: "consolidate",
		data: { runId: "con-1", ok: true },
	};
	const derived = detectPresumedCrashes([synthesizeStart, consolidateStart, consolidateEnd]);
	assert.equal(derived.length, 1);
	assert.equal(derived[0].actor, "synthesize");
	assert.equal(derived[0].derived, true);
	assert.equal(derived[0].kind, "organ.presumed_crash");
});

test("host.run crash grammar is bracket pairing, not first-boot false positive", async () => {
	const actor = "heartbeat";
	const startA = {
		id: uuidv7(),
		ts: "2026-08-17T01:00:00.000Z",
		kind: "host.run.start" as const,
		actor,
		data: { runId: "run-a" },
	};
	const endA = {
		id: uuidv7(),
		ts: "2026-08-17T01:00:01.000Z",
		kind: "host.run.end" as const,
		actor,
		data: { runId: "run-a", ok: true },
	};
	assert.deepEqual(detectPresumedCrashes([startA, endA]), []);

	const startB = {
		id: uuidv7(),
		ts: "2026-08-17T01:01:00.000Z",
		kind: "host.run.start" as const,
		actor,
		data: { runId: "run-b" },
	};
	const startC = {
		id: uuidv7(),
		ts: "2026-08-17T01:02:00.000Z",
		kind: "host.run.start" as const,
		actor,
		data: { runId: "run-c" },
	};
	const abandoned = detectPresumedCrashes([startB, startC]);
	assert.equal(abandoned.length, 1);
	assert.equal(abandoned[0].actor, actor);
	assert.equal(abandoned[0].derived, true);
	assert.equal((abandoned[0].data as { runId: string }).runId, "run-b");

	const planned = {
		id: uuidv7(),
		ts: "2026-08-17T01:01:30.000Z",
		kind: "host.restart_planned" as const,
		actor,
		data: { runId: "run-b" },
	};
	assert.deepEqual(detectPresumedCrashes([startB, planned, startC]), []);

	const firstBoot = {
		id: uuidv7(),
		ts: "2026-08-17T02:00:00.000Z",
		kind: "host.run.start" as const,
		actor,
		data: { runId: "first" },
	};
	assert.deepEqual(detectPresumedCrashes([firstBoot]), []);
});

test("listHerEvents filters newest-first and can attach derived crashes", async () => {
	const root = await tempMemory();
	const older = await appendEvent("host.run.start", "heartbeat", { runId: "old" }, undefined, root);
	const newer = await appendEvent("organ.round.start", "synthesize", { runId: "syn" }, undefined, root);
	const listed = await listHerEvents(root, { limit: 10 });
	assert.deepEqual(
		listed.map((event) => event.id),
		[newer.id, older.id],
	);
	const kinded = await listHerEvents(root, { kind: "organ.round.start" });
	assert.deepEqual(
		kinded.map((event) => event.id),
		[newer.id],
	);
	const since = await listHerEvents(root, { since: newer.ts });
	assert.ok(since.every((event) => event.ts >= newer.ts));
	const withDerived = await listHerEvents(root, { includeDerived: true });
	assert.ok(withDerived.some((event) => event.derived === true && event.actor === "synthesize"));
});

test("list_her_events is a non-destructive governed tool and is registered", async () => {
	assert.deepEqual(resolveGovernedTool("list_her_events"), { destructive: false, registered: true });
	assert.equal(resolveGovernedTool("appendEvent").registered, false);

	const root = await tempMemory();
	await appendEvent("host.run.start", "heartbeat", { runId: "tool" }, undefined, root);
	await withMemoryDir(root, async () => {
		const tools = new Map<string, ToolDefinition>();
		const pi = {
			on() {},
			registerTool(tool: ToolDefinition) {
				tools.set(tool.name, tool);
			},
			registerProvider() {},
			appendEntry() {},
			sendMessage() {},
			sendUserMessage() {},
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
			getFlag() {
				return undefined;
			},
			registerMessageRenderer() {},
			setSessionName() {},
			getSessionName() {
				return undefined;
			},
			setLabel() {},
			exec() {
				throw new Error("exec not implemented");
			},
			getActiveTools() {
				return [];
			},
			getAllTools() {
				return [];
			},
			setActiveTools() {},
			getCommands() {
				return [];
			},
			async setModel() {
				return false;
			},
			getThinkingLevel() {
				return "medium";
			},
			setThinkingLevel() {},
			unregisterProvider() {},
			events: { on() {}, off() {}, emit() {} },
		} as unknown as ExtensionAPI;
		her(pi);
		const tool = tools.get("list_her_events");
		assert.ok(tool);
		const result = (await tool.execute(
			"id",
			{ kind: "host.run.start", limit: 5 },
			undefined,
			undefined,
			undefined as never,
		)) as {
			details?: { events?: Array<{ kind: string }> };
		};
		assert.ok(result.details?.events?.every((event) => event.kind === "host.run.start"));
	});
});

test("host-event CLI is a sealed runner vocabulary with no --actor", async () => {
	const root = await tempMemory();
	const io = { stdout: { write() {} }, stderr: { write() {} } };
	const env = { HER_MEMORY_DIR: root };
	const start = await runHerCli(
		["host-event", "run-start", "--runner", "heartbeat", "--run-id", "cli-1"],
		env,
		root,
		io as never,
	);
	assert.equal(start, 0);
	const end = await runHerCli(
		["host-event", "run-end", "--runner", "heartbeat", "--run-id", "cli-1", "--ok", "true", "--exit-code", "0"],
		env,
		root,
		io as never,
	);
	assert.equal(end, 0);
	const actor = await runHerCli(
		["host-event", "run-start", "--runner", "heartbeat", "--run-id", "cli-2", "--actor", "forged"],
		env,
		root,
		io as never,
	);
	assert.equal(actor, 2);
	const badRunner = await runHerCli(
		["host-event", "run-start", "--runner", "not-a-runner", "--run-id", "cli-3"],
		env,
		root,
		io as never,
	);
	assert.equal(badRunner, 2);
	const events = await readEventHistory(root);
	assert.equal(events.events.length, 2);
	assert.equal(events.events[0].actor, "heartbeat");
	assert.equal(events.events[1].kind, "host.run.end");
});

function spawnAppendWorker(root: string, count: number, actor: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", workerPath, String(count), actor], {
			env: { ...process.env, HER_MEMORY_DIR: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`append worker exited ${code}: ${stderr}`));
		});
	});
}
