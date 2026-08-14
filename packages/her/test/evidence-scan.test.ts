import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { frontmatter, initStore, parseFrontmatter, readText, writeText } from "../src/her-core/index.ts";
import { runDreamScan } from "../src/her-core/evidence-scan.ts";

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "her-dream-scan-"));
	try {
		await initStore(root);
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeRawEpisode(root: string, id: string, body: string, ts = "2026-08-13T1200"): Promise<void> {
	await writeText(
		join(root, "episodic", "raw", `${ts}--${id}.md`),
		`${frontmatter({ id, timestamp: ts, project: "her" })}${body}\n`,
	);
}

function dreamFiles(names: string[]): string[] {
	return names.filter((name) => name.startsWith("dream-") && name.endsWith(".md")).sort();
}

test("remember-request user block writes a dream proposal with episode source and snippet", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const result = await runDreamScan(root);
		assert.equal(result.written, 1);
		assert.equal(result.matched, 1);
		const files = dreamFiles(await readdir(join(root, "proposals")));
		assert.equal(files.length, 1);
		const parsed = parseFrontmatter(await readText(join(root, "proposals", files[0])));
		assert.equal(parsed.data.kind, "dream-proposal");
		assert.equal(parsed.data.signal, "remember-request");
		assert.equal(parsed.data.status, "pending");
		assert.equal(parsed.data.risk, "low");
		assert.deepEqual(parsed.data.sources, ["ep-remember-1"]);
		assert.match(parsed.body ?? "", /以后都记住:构建前先跑 lint/);
	});
});

test("explicit-correction user block writes a dream proposal", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-correct-1", "user: 不对,我不是这个意思,你应该用 pnpm\n");
		const result = await runDreamScan(root);
		assert.equal(result.written, 1);
		const files = dreamFiles(await readdir(join(root, "proposals")));
		assert.equal(files.length, 1);
		const parsed = parseFrontmatter(await readText(join(root, "proposals", files[0])));
		assert.equal(parsed.data.signal, "explicit-correction");
		assert.deepEqual(parsed.data.sources, ["ep-correct-1"]);
		assert.match(parsed.body ?? "", /不对,我不是这个意思,你应该用 pnpm/);
	});
});
