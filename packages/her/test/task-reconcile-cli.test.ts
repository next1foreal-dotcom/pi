/**
 * G-360 — CLI entry for reconcileBgTasks: scheduled tick without resident runtime.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/task-reconcile-cli.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
	const chunks: Buffer[] = [];
	const stream = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			cb();
		},
	});
	return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

async function makeMemoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-task-reconcile-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 5", "  max_retries: 0", ""].join("\n"),
		"utf8",
	);
	return root;
}

test("task-reconcile: no tasks -> exit 0, empty events", async () => {
	const root = await makeMemoryRoot();
	const stdout = capture();
	const stderr = capture();
	const code = await runHerCli(["task-reconcile"], { ...process.env, HER_MEMORY_DIR: root }, root, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr.text()}`);
	assert.match(stdout.text(), /0 event/, "should report zero events");
});

test("task-reconcile --json: output is JSON-parseable with events and wakeupsFired", async () => {
	const root = await makeMemoryRoot();
	const stdout = capture();
	const stderr = capture();
	const code = await runHerCli(["task-reconcile", "--json"], { ...process.env, HER_MEMORY_DIR: root }, root, {
		stdout: stdout.stream,
		stderr: stderr.stream,
	});
	assert.equal(code, 0, `expected exit 0, got ${code}; stderr: ${stderr.text()}`);
	const parsed = JSON.parse(stdout.text().trim()) as { events?: unknown; wakeupsFired?: unknown };
	assert.ok(Array.isArray(parsed.events), "expected events array");
	assert.equal(parsed.events.length, 0, "expected empty events for no tasks");
	assert.deepEqual(parsed.wakeupsFired, [], "expected empty wakeupsFired when no due alarms");
});
