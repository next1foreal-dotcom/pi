import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type BgTaskRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { purgeExpiredTaskArtifacts } from "../src/her-core/bg-task-retention.ts";
import { externalizeLargeDataUris } from "../src/her-core/publish-assets.ts";

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g128-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  retention_days: 30\n", "utf8");
	return root;
}

test("A.8 retention purges sentinels but keeps .md", async () => {
	const root = await memoryRoot();
	const id = "t-20260101-old";
	const record: BgTaskRecord = {
		id,
		status: "completed",
		objective: "old",
		worker: "cheap_worker",
		command: ["node"],
		created: "2020-01-01T00:00:00.000Z",
		updated: "2020-01-01T00:00:00.000Z",
		endedAt: "2020-01-01T00:00:00.000Z",
		retries: 0,
		host: "box",
		notifiedAt: "2020-01-01T00:00:00.000Z",
	};
	await saveBgTask(root, record, "# old\n");
	const dir = tasksDir(root);
	await writeFile(join(dir, `${id}.log`), "log\n", "utf8");
	await writeFile(join(dir, `${id}.done`), '{"exitCode":0}\n', "utf8");
	await writeFile(join(dir, `${id}.pid`), '{"runnerPid":1}\n', "utf8");

	const purged = await purgeExpiredTaskArtifacts(root, {
		now: new Date("2026-07-26T00:00:00.000Z"),
		retentionDays: 30,
	});
	assert.equal(purged.length, 1);
	assert.ok(purged[0]?.removed.includes(`${id}.log`));
	await assert.rejects(() => readFile(join(dir, `${id}.log`)));
	assert.match(await readFile(join(dir, `${id}.md`), "utf8"), /old/);
});

test("A.8 retention skips fresh terminal tasks", async () => {
	const root = await memoryRoot();
	const id = "t-20260726-new";
	await saveBgTask(
		root,
		{
			id,
			status: "failed",
			objective: "fresh",
			worker: "cheap_worker",
			command: ["node"],
			created: "2026-07-20T00:00:00.000Z",
			updated: "2026-07-20T00:00:00.000Z",
			endedAt: "2026-07-20T00:00:00.000Z",
			retries: 0,
			host: "box",
		},
		"# fresh\n",
	);
	await writeFile(join(tasksDir(root), `${id}.log`), "x\n", "utf8");
	const purged = await purgeExpiredTaskArtifacts(root, {
		now: new Date("2026-07-26T00:00:00.000Z"),
		retentionDays: 30,
	});
	assert.equal(purged.length, 0);
	assert.equal(await readFile(join(tasksDir(root), `${id}.log`), "utf8"), "x\n");
});

test("D.2 externalize data URIs when over threshold", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-pub-"));
	const pub = join(root, "published");
	await mkdir(pub, { recursive: true });
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const b64 = png.toString("base64");
	const html = `<html><body>${"x".repeat(600_000)}<img src="data:image/png;base64,${b64}"/></body></html>`;
	const result = await externalizeLargeDataUris(html, pub, 524_288);
	assert.ok(result.rewrote >= 1);
	assert.equal(result.assets.length, 1);
	assert.match(result.html, /src="assets\/[a-f0-9]{16}\.png"/);
	assert.doesNotMatch(result.html, /data:image\/png;base64/);
	const assetPath = join(pub, result.assets[0]!);
	assert.deepEqual(await readFile(assetPath), png);
});

test("D.2 skips externalize under threshold", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-pub2-"));
	const pub = join(root, "published");
	await mkdir(pub, { recursive: true });
	const html = `<img src="data:image/png;base64,AQID"/>`;
	const result = await externalizeLargeDataUris(html, pub, 524_288);
	assert.equal(result.rewrote, 0);
	assert.match(result.html, /data:image\/png;base64/);
});
