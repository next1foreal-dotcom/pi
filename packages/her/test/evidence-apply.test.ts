import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runHerCli } from "../src/cli.ts";
import { applyDreamProposal, rejectDreamProposal } from "../src/her-core/evidence-apply.ts";
import { runDreamScan } from "../src/her-core/evidence-scan.ts";
import { frontmatter, initStore, parseFrontmatter, readText, writeText } from "../src/her-core/index.ts";

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "her-dream-apply-"));
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

async function scanOne(root: string, id: string, body: string): Promise<string> {
	await writeRawEpisode(root, id, body);
	const before = new Set(dreamFiles(await readdir(join(root, "proposals"))));
	const result = await runDreamScan(root);
	assert.equal(result.written, 1);
	const added = dreamFiles(await readdir(join(root, "proposals"))).filter((name) => !before.has(name));
	assert.equal(added.length, 1);
	return added[0].replace(/\.md$/, "");
}

async function snapshotFile(path: string): Promise<string> {
	const buf = await readFile(path);
	return `${buf.length}:${createHash("sha256").update(buf).digest("hex")}`;
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
			out[relPath] = await snapshotFile(full);
		}
	};
	await walk(join(root, rel), rel);
	return out;
}

async function runCli(
	root: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
	stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: root }, root, { stdout, stderr });
	return {
		code,
		stdout: Buffer.concat(outChunks).toString("utf8"),
		stderr: Buffer.concat(errChunks).toString("utf8"),
	};
}

test("dream-apply writes a semantic note from the stripped body and flips status", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const contextBefore = await snapshotFile(join(root, "narrative", "CONTEXT.md"));
		const rawBefore = await snapshotTree(root, "episodic");
		const result = await applyDreamProposal(root, proposalId);
		assert.equal(result.written, true);
		assert.equal(result.status, "applied");
		assert.equal(result.skippedIdempotent, false);
		const proposal = parseFrontmatter(await readText(join(root, "proposals", `${proposalId}.md`)));
		assert.equal(proposal.data.status, "applied");
		assert.equal(proposal.data.applied_note, "dream-ep-remember-1");
		const note = parseFrontmatter(await readText(join(root, "semantic", "dream-ep-remember-1.md")));
		assert.equal(note.data.kind, undefined);
		assert.equal(note.data.dream_proposal, proposalId);
		assert.deepEqual(note.data.sources, ["ep-remember-1"]);
		assert.match(note.body ?? "", /以后都记住:构建前先跑 lint/);
		assert.equal(note.body?.includes("kind: dream-proposal"), false);
		assert.equal(await snapshotFile(join(root, "narrative", "CONTEXT.md")), contextBefore);
		assert.deepEqual(await snapshotTree(root, "episodic"), rawBefore);
	});
});

test("dream-reject flips status and writes no semantic note", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-correct-1", "user: 不对,我不是这个意思,你应该用 pnpm\n");
		const contextBefore = await snapshotFile(join(root, "narrative", "CONTEXT.md"));
		const semanticBefore = await snapshotTree(root, "semantic");
		const result = await rejectDreamProposal(root, proposalId);
		assert.equal(result.written, true);
		assert.equal(result.status, "rejected");
		const proposal = parseFrontmatter(await readText(join(root, "proposals", `${proposalId}.md`)));
		assert.equal(proposal.data.status, "rejected");
		assert.deepEqual(await snapshotTree(root, "semantic"), semanticBefore);
		assert.equal(await snapshotFile(join(root, "narrative", "CONTEXT.md")), contextBefore);
	});
});

test("non-dream proposal ids are rejected and CONTEXT is unchanged", async () => {
	await withStore(async (root) => {
		const collisionPath = join(root, "proposals", "2026-08-13-narrative-update.md");
		await writeText(collisionPath, "---\nid: 2026-08-13-narrative-update\n---\nkeep this body\n");
		const contextBefore = await snapshotFile(join(root, "narrative", "CONTEXT.md"));
		await assert.rejects(() => applyDreamProposal(root, "2026-08-13-narrative-update"), /not a dream proposal id/);
		await assert.rejects(() => rejectDreamProposal(root, "2026-08-13-narrative-update"), /not a dream proposal id/);
		assert.equal(await snapshotFile(join(root, "narrative", "CONTEXT.md")), contextBefore);
		assert.equal(await readFile(collisionPath, "utf8"), "---\nid: 2026-08-13-narrative-update\n---\nkeep this body\n");
	});
});

test("second apply on the same proposal is idempotent", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const first = await applyDreamProposal(root, proposalId);
		assert.equal(first.written, true);
		const noteBefore = await snapshotFile(join(root, "semantic", "dream-ep-remember-1.md"));
		const second = await applyDreamProposal(root, proposalId);
		assert.equal(second.written, false);
		assert.equal(second.skippedIdempotent, true);
		assert.equal(await snapshotFile(join(root, "semantic", "dream-ep-remember-1.md")), noteBefore);
	});
});

test("apply after reject and reject after apply fail loud", async () => {
	await withStore(async (root) => {
		const rejectedId = await scanOne(root, "ep-correct-1", "user: 不对,我不是这个意思,你应该用 pnpm\n");
		await rejectDreamProposal(root, rejectedId);
		await assert.rejects(() => applyDreamProposal(root, rejectedId), /already rejected/);
		const appliedId = await scanOne(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		await applyDreamProposal(root, appliedId);
		await assert.rejects(() => rejectDreamProposal(root, appliedId), /already applied/);
	});
});

test("dry-run apply writes nothing", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const proposalsBefore = await snapshotFile(join(root, "proposals", `${proposalId}.md`));
		const semanticBefore = await snapshotTree(root, "semantic");
		const result = await applyDreamProposal(root, proposalId, { dryRun: true });
		assert.equal(result.written, false);
		assert.equal(result.status, "pending");
		assert.equal(await snapshotFile(join(root, "proposals", `${proposalId}.md`)), proposalsBefore);
		assert.deepEqual(await snapshotTree(root, "semantic"), semanticBefore);
	});
});

test("evidence-apply module does not import model or Memory.approve", async () => {
	const sourcePath = fileURLToPath(new URL("../src/her-core/evidence-apply.ts", import.meta.url));
	const source = await readFile(sourcePath, "utf8");
	assert.equal(/from\s+["'][^"']*model\.ts["']/.test(source), false);
	assert.equal(/\bFakeModel\b|\bOpenAICompatibleModel\b|\.complete\(/.test(source), false);
	assert.equal(/from\s+["']\.\/memory\.ts["']/.test(source), false);
});

test("CLI dream-apply --json writes the semantic note", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-remember-1", "user: 以后都记住:构建前先跑 lint\n");
		const { code, stdout } = await runCli(root, ["dream-apply", "--proposal", proposalId, "--json"]);
		assert.equal(code, 0);
		const payload = JSON.parse(stdout) as { status: string; written: boolean; proposalId: string };
		assert.equal(payload.status, "applied");
		assert.equal(payload.written, true);
		assert.equal(payload.proposalId, proposalId);
		assert.equal((await readText(join(root, "semantic", "dream-ep-remember-1.md"))) !== undefined, true);
	});
});

test("CLI dream-reject --json flips status only", async () => {
	await withStore(async (root) => {
		const proposalId = await scanOne(root, "ep-correct-1", "user: 不对,我不是这个意思,你应该用 pnpm\n");
		const { code, stdout } = await runCli(root, ["dream-reject", "--proposal", proposalId, "--json"]);
		assert.equal(code, 0);
		const payload = JSON.parse(stdout) as { status: string; written: boolean };
		assert.equal(payload.status, "rejected");
		assert.equal(payload.written, true);
		assert.equal(await readText(join(root, "semantic", "dream-ep-correct-1.md")), undefined);
	});
});
