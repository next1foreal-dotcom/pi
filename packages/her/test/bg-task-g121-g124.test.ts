import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { parseTasksPublish } from "../src/her-core/bg-task-config.ts";
import { truncateLogBuffer } from "../src/her-core/bg-task-log.ts";
import { enqueueTaskTelegramNotices, formatBgTaskStatusBoard } from "../src/her-core/bg-task-notify.ts";
import { spawnBgTask, stopBgTask } from "../src/her-core/bg-task-spawn.ts";
import { herPublish, slugifyTitle, stopPublishServer } from "../src/her-core/her-publish.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g121-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await mkdir(join(root, "outbox"), { recursive: true });
	return root;
}

test("T9: truncateLogBuffer keeps head and tail", () => {
	const buf = Buffer.alloc(3_000_000, 0x61); // 'a'
	buf.write("HEADSTART", 0);
	buf.write("TAILEND!!", buf.length - 9);
	const { buffer, truncated, removed } = truncateLogBuffer(buf, {
		logCapBytes: 1_000_000,
		logHeadBytes: 100,
		logTailBytes: 100,
	});
	assert.equal(truncated, true);
	assert.ok(removed > 0);
	assert.match(buffer.subarray(0, 20).toString("utf8"), /HEADSTART/);
	assert.match(buffer.toString("utf8"), /truncated/);
	assert.match(buffer.subarray(buffer.length - 20).toString("utf8"), /TAILEND/);
});

test("T13: concurrency gate denies 4th running", async () => {
	const root = await memoryRoot();
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  max_concurrent: 2", "  budget_daily_cap: 999", ""].join("\n"),
		"utf8",
	);
	const cmd = [process.execPath, "-e", "setTimeout(()=>{}, 30000)"];
	const a = await spawnBgTask(root, { objective: "a", command: cmd, skipGates: false, heartbeatMs: 2000 });
	const b = await spawnBgTask(root, { objective: "b", command: cmd, skipGates: false, heartbeatMs: 2000 });
	assert.equal(a.status, "running");
	assert.equal(b.status, "running");
	const c = await spawnBgTask(root, { objective: "c", command: cmd, skipGates: false, heartbeatMs: 2000 });
	assert.equal(c.status, "failed");
	if (c.status === "failed") {
		assert.equal(c.failureReason, "budget_denied");
		assert.ok(c.gates?.some((g) => g.name === "concurrency"));
	}
	if (a.status === "running") await stopBgTask(root, a.id);
	if (b.status === "running") await stopBgTask(root, b.id);
	await sleep(100);
});

test("parseTasksPublish reads tasks keys", () => {
	const parsed = parseTasksPublish("tasks:\n  max_concurrent: 4\n  telegram_notify: false\n");
	assert.equal(parsed.tasks?.maxConcurrent, 4);
	assert.equal(parsed.tasks?.telegramNotify, false);
});

test("G-123 telegram outbox + status board", async () => {
	const root = await memoryRoot();
	const paths = await enqueueTaskTelegramNotices(root, [
		{ taskId: "t-1", status: "completed", objective: "demo", exitCode: 0 },
	]);
	assert.equal(paths.length, 1);
	const board = await formatBgTaskStatusBoard(root);
	assert.match(board, /^bg /);
});

test("G-124 her_publish writes published html", async () => {
	const root = await memoryRoot();
	await mkdir(join(root, ".git"), { recursive: true });
	const src = join(root, "page.html");
	await writeFile(src, "<h1>Hello</h1>", "utf8");
	const result = await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		publish: { bind: "127.0.0.1", port: 18788, inlineThresholdBytes: 524288, maxAssetBytes: 5_000_000 },
	});
	assert.equal(result.slug, "hello-page");
	assert.match(result.url, /18788/);
	const html = await readFile(join(root, "published", "hello-page.html"), "utf8");
	assert.match(html, /Hello/);
	await stopPublishServer();
});

test("slugifyTitle", () => {
	assert.equal(slugifyTitle("Hello World!"), "hello-world");
});
