import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const scriptPath = join(repoRoot, "scripts", "check-taste-schema.mjs");

async function tasteSchemaStore(): Promise<string> {
	const store = await mkdtemp(join(tmpdir(), "her-taste-schema-"));
	await mkdir(join(store, "world"), { recursive: true });
	return store;
}

test("check-taste-schema passes a well-formed taste card and ignores non-taste notes", async () => {
	const store = await tasteSchemaStore();
	await writeFile(
		join(store, "world", "good-card.md"),
		[
			"---",
			"id: abc12345",
			"title: Good Card",
			"source_url: https://example.com/good",
			"source_type: taste-card",
			"captured_at: 2026-07-21T00:00:00.000Z",
			"boards:",
			"  - design",
			'fei: ""',
			'snapshot: {"text":"world/_snapshots/good-card-aaaaaaaa/original.md","screenshot":null,"media":[]}',
			"---",
			"",
			"# Good Card",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(store, "world", "ordinary-note.md"),
		[
			"---",
			"id: def67890",
			"title: Ordinary Note",
			"source_url: https://example.com/ordinary",
			"source_type: article",
			"captured_at: 2026-07-21T00:00:00.000Z",
			"---",
			"",
			"# Ordinary Note",
			"",
		].join("\n"),
		"utf8",
	);

	const result = await execFileAsync(process.execPath, [scriptPath], {
		env: { ...process.env, HER_MEMORY_DIR: store },
	});
	assert.match(result.stdout, /2 world note\(s\) scanned/);
});

test("check-taste-schema fails loud and names the file and missing field for a taste card missing boards", async () => {
	const store = await tasteSchemaStore();
	await writeFile(
		join(store, "world", "missing-boards.md"),
		[
			"---",
			"id: abc12345",
			"title: Missing Boards",
			"source_url: https://example.com/missing",
			"source_type: taste-card",
			"captured_at: 2026-07-21T00:00:00.000Z",
			'fei: ""',
			'snapshot: {"text":"world/_snapshots/missing-boards-aaaaaaaa/original.md","screenshot":null,"media":[]}',
			"---",
			"",
			"# Missing Boards",
			"",
		].join("\n"),
		"utf8",
	);

	await assert.rejects(
		() => execFileAsync(process.execPath, [scriptPath], { env: { ...process.env, HER_MEMORY_DIR: store } }),
		(error: unknown) => {
			const err = error as { code?: number; stderr?: string };
			assert.equal(err.code, 1);
			assert.match(err.stderr ?? "", /missing-boards\.md/);
			assert.match(err.stderr ?? "", /boards/);
			return true;
		},
	);
});
