import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import { appendEvent, eventHistoryPath, eventHistoryStatePath } from "../src/her-core/event-history.ts";
import {
	eventHistoryAlertPath,
	type VerifyAlertSender,
	verifyEventHistoryPrefix,
} from "../src/her-core/event-history-verify.ts";
import { initStore } from "../src/her-core/index.ts";

async function tempMemory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g270-verify-"));
	await initStore(root);
	return root;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test("events-verify turns red on truncate, mid rewrite, first-line replace, and lastId regression, then green on append", async () => {
	const root = await tempMemory();
	const sent: string[] = [];
	const sendAlert: VerifyAlertSender = async (text) => {
		sent.push(text);
	};

	await appendEvent("host.run.start", "heartbeat", { runId: "v1" }, undefined, root);
	await appendEvent("host.run.end", "heartbeat", { runId: "v1", ok: true }, undefined, root);
	const green1 = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(green1.ok, true);
	assert.equal(sent.length, 0);
	const state1 = JSON.parse(await readFile(eventHistoryStatePath(root), "utf8")) as {
		prefixLength: number;
		prefixSha256: string;
		lastId: string;
	};
	const file1 = await readFile(eventHistoryPath(root));
	assert.equal(state1.prefixLength, file1.byteLength);
	assert.equal(state1.prefixSha256, sha256(file1));

	await writeFile(eventHistoryPath(root), file1.subarray(0, Math.max(1, file1.byteLength - 20)));
	const truncated = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(truncated.ok, false);
	assert.match(truncated.reason ?? "", /truncat/i);
	assert.equal(sent.length, 1);
	assert.equal((await readFile(eventHistoryAlertPath(root), "utf8")).length > 0, true);

	await writeFile(eventHistoryPath(root), file1);
	await verifyEventHistoryPrefix({ root, sendAlert: async () => {} });
	const flipped = Buffer.from(file1);
	const mid = Math.floor(flipped.byteLength / 2);
	flipped[mid] = flipped[mid] === 0x61 ? 0x62 : 0x61;
	await writeFile(eventHistoryPath(root), flipped);
	sent.length = 0;
	const rewritten = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(rewritten.ok, false);
	assert.match(rewritten.reason ?? "", /prefix|mismatch|rewrite/i);
	assert.equal(sent.length, 1);

	await writeFile(eventHistoryPath(root), file1);
	await verifyEventHistoryPrefix({ root, sendAlert: async () => {} });
	const lines = file1.toString("utf8").split("\n").filter(Boolean);
	const first = JSON.parse(lines[0]) as { id: string; actor: string };
	first.actor = "forged";
	const replacedFirst = `${JSON.stringify(first)}\n${lines.slice(1).join("\n")}\n`;
	await writeFile(eventHistoryPath(root), replacedFirst);
	sent.length = 0;
	const firstLine = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(firstLine.ok, false);
	assert.equal(sent.length, 1);

	await writeFile(eventHistoryPath(root), file1);
	await writeFile(
		eventHistoryStatePath(root),
		`${JSON.stringify({
			prefixLength: 0,
			prefixSha256: sha256(Buffer.alloc(0)),
			lastId: "ffffffff-ffff-7fff-bfff-ffffffffffff",
		})}\n`,
	);
	sent.length = 0;
	const regressed = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(regressed.ok, false);
	assert.match(regressed.reason ?? "", /lastId|last_id|regress/i);
	assert.equal(sent.length, 1);

	await writeFile(eventHistoryPath(root), file1);
	await writeFile(
		eventHistoryStatePath(root),
		`${JSON.stringify({
			prefixLength: file1.byteLength,
			prefixSha256: sha256(file1),
			lastId: state1.lastId,
		})}\n`,
	);
	await appendEvent("host.run.start", "heartbeat", { runId: "v2" }, undefined, root);
	sent.length = 0;
	const green2 = await verifyEventHistoryPrefix({ root, sendAlert });
	assert.equal(green2.ok, true);
	assert.equal(sent.length, 0);
	const state2 = JSON.parse(await readFile(eventHistoryStatePath(root), "utf8")) as {
		prefixLength: number;
		lastId: string;
	};
	const file2 = await readFile(eventHistoryPath(root));
	assert.equal(state2.prefixLength, file2.byteLength);
	assert.ok(state2.prefixLength > state1.prefixLength);
	assert.ok(state2.lastId > state1.lastId);
});

test("her events-verify CLI exits non-zero on a truncated history", async () => {
	const root = await tempMemory();
	await appendEvent("host.run.start", "heartbeat", { runId: "cli" }, undefined, root);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const first = await runHerCli(["events-verify"], { HER_MEMORY_DIR: root }, root, { stdout, stderr });
	assert.equal(first, 0);
	const file = await readFile(eventHistoryPath(root));
	await writeFile(eventHistoryPath(root), file.subarray(0, 4));
	const second = await runHerCli(["events-verify"], { HER_MEMORY_DIR: root }, root, { stdout, stderr });
	assert.notEqual(second, 0);
});
