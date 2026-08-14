import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runHerCli } from "../src/cli.ts";
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

async function snapshotTree(root: string, rel: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const walk = async (dir: string, prefix: string): Promise<void> => {
		let names: string[];
		try {
			names = (await readdir(dir)).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const full = join(dir, name);
			const relPath = prefix ? `${prefix}/${name}` : name;
			const info = await stat(full);
			if (info.isDirectory()) {
				await walk(full, relPath);
				continue;
			}
			const buf = await readFile(full);
			out[relPath] = `${info.size}:${createHash("sha256").update(buf).digest("hex")}`;
		}
	};
	await walk(join(root, rel), rel);
	return out;
}

async function snapshotMemoryDirs(root: string): Promise<Record<string, string>> {
	return {
		...(await snapshotTree(root, "episodic")),
		...(await snapshotTree(root, "semantic")),
		...(await snapshotTree(root, "narrative")),
	};
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

test("Codex AGENTS transcript without user blocks writes zero proposals", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(
			root,
			"ep-agents-1",
			[
				"# AGENTS.md",
				"",
				"You should always remember to follow these workspace rules.",
				"From now on, prefer the tools listed below.",
				"",
			].join("\n"),
		);
		const result = await runDreamScan(root);
		assert.equal(result.written, 0);
		assert.equal(result.matched, 0);
		assert.deepEqual(dreamFiles(await readdir(join(root, "proposals"))), []);
	});
});

test("assistant remember wording with a clean user block writes zero proposals", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(
			root,
			"ep-assistant-1",
			["user: ship the lint fix", "", "assistant: 记住, I will run lint first.", ""].join("\n"),
		);
		const result = await runDreamScan(root);
		assert.equal(result.written, 0);
		assert.equal(result.matched, 0);
		assert.deepEqual(dreamFiles(await readdir(join(root, "proposals"))), []);
	});
});

test("evidence-scan module does not import the model module", async () => {
	const sourcePath = fileURLToPath(new URL("../src/her-core/evidence-scan.ts", import.meta.url));
	const source = await readFile(sourcePath, "utf8");
	assert.equal(/from\s+["']\.\/model\.ts["']/.test(source), false);
	assert.equal(/from\s+["'][^"']*model["']/.test(source), false);
	assert.equal(/\bFakeModel\b|\bOpenAICompatibleModel\b|\.complete\(/.test(source), false);
});

test("dream-scan leaves episodic semantic and narrative unchanged and only adds dream proposals", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const before = await snapshotMemoryDirs(root);
		const proposalsBefore = new Set(await readdir(join(root, "proposals")));
		const result = await runDreamScan(root);
		assert.equal(result.written, 1);
		assert.deepEqual(await snapshotMemoryDirs(root), before);
		const added = (await readdir(join(root, "proposals"))).filter((name) => !proposalsBefore.has(name));
		assert.ok(added.length >= 1);
		assert.ok(added.every((name) => name.startsWith("dream-") && name.endsWith(".md")));
	});
});

test("dream-scan does not overwrite an existing narrative-update proposal", async () => {
	await withStore(async (root) => {
		const collisionPath = join(root, "proposals", "2026-08-13-narrative-update.md");
		const original = "---\nid: 2026-08-13-narrative-update\n---\nkeep this body\n";
		await writeText(collisionPath, original);
		const before = await readFile(collisionPath);
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		await runDreamScan(root);
		const after = await readFile(collisionPath);
		assert.deepEqual(after, before);
		assert.equal(after.length, before.length);
	});
});

test("second dream-scan on the same fixture writes zero proposals", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const first = await runDreamScan(root);
		assert.equal(first.written, 1);
		const filesAfterFirst = dreamFiles(await readdir(join(root, "proposals")));
		const second = await runDreamScan(root);
		assert.equal(second.written, 0);
		assert.equal(second.skippedIdempotent, 1);
		assert.deepEqual(dreamFiles(await readdir(join(root, "proposals"))), filesAfterFirst);
	});
});

test("dry-run reports candidates and writes no proposal files", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const proposalsBefore = new Set(await readdir(join(root, "proposals")));
		const result = await runDreamScan(root, { dryRun: true });
		assert.equal(result.written, 0);
		assert.equal(result.matched, 1);
		assert.equal(result.candidates.length, 1);
		assert.equal(result.candidates[0]?.signal, "remember-request");
		assert.deepEqual(new Set(await readdir(join(root, "proposals"))), proposalsBefore);
	});
});

async function runDreamScanCli(
	root: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
	stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
	const code = await runHerCli(["dream-scan", ...args], { ...process.env, HER_MEMORY_DIR: root }, root, {
		stdout,
		stderr,
	});
	return {
		code,
		stdout: Buffer.concat(outChunks).toString("utf8"),
		stderr: Buffer.concat(errChunks).toString("utf8"),
	};
}

test("CLI dream-scan prints a one-line summary and writes a proposal", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const { code, stdout } = await runDreamScanCli(root, []);
		assert.equal(code, 0);
		assert.match(stdout, /scanned 1 \/ matched 1 \/ proposals written 1 \/ skipped-idempotent 0/);
		assert.equal(dreamFiles(await readdir(join(root, "proposals"))).length, 1);
	});
});

test("CLI --dry-run prints candidates and writes no proposal files", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const proposalsBefore = new Set(await readdir(join(root, "proposals")));
		const { code, stdout } = await runDreamScanCli(root, ["--dry-run"]);
		assert.equal(code, 0);
		assert.match(stdout, /ep-remember-1 remember-request/);
		assert.match(stdout, /scanned 1 \/ matched 1 \/ proposals written 0 \/ skipped-idempotent 0/);
		assert.deepEqual(new Set(await readdir(join(root, "proposals"))), proposalsBefore);
	});
});

test("user_query block is extracted as a remember-request", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(
			root,
			"ep-query-1",
			"<user_query>\n以后都记住:构建前先跑 lint\n</user_query>\n",
		);
		const result = await runDreamScan(root);
		assert.equal(result.written, 1);
		const files = dreamFiles(await readdir(join(root, "proposals")));
		const parsed = parseFrontmatter(await readText(join(root, "proposals", files[0] ?? "")));
		assert.equal(parsed.data.signal, "remember-request");
		assert.deepEqual(parsed.data.sources, ["ep-query-1"]);
	});
});

test("limit processes newest raw files first", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-old", "user: 以后都记住:构建前先跑 lint\n", "2026-08-01T1200");
		await writeRawEpisode(root, "ep-new", "user: ship the lint fix\n", "2026-08-13T1800");
		const limited = await runDreamScan(root, { limit: 1 });
		assert.equal(limited.scanned, 1);
		assert.equal(limited.written, 0);
		const full = await runDreamScan(root);
		assert.equal(full.scanned, 2);
		assert.equal(full.written, 1);
		assert.deepEqual(full.candidates[0]?.episodeId, "ep-old");
	});
});

test("CLI --json emits structured dream-scan output", async () => {
	await withStore(async (root) => {
		await writeRawEpisode(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const { code, stdout } = await runDreamScanCli(root, ["--json"]);
		assert.equal(code, 0);
		const payload = JSON.parse(stdout) as {
			matched: number;
			scanned: number;
			skippedIdempotent: number;
			written: number;
		};
		assert.equal(payload.scanned, 1);
		assert.equal(payload.matched, 1);
		assert.equal(payload.written, 1);
		assert.equal(payload.skippedIdempotent, 0);
	});
});
