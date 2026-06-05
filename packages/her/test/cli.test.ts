import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initStore, Memory } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitBackedStore(): Promise<{ store: string; remote: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-cli-"));
	const remote = await mkdtemp(join(tmpdir(), "her-cli-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her CLI Test");
	await git(store, "config", "user.email", "her-cli-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	return { store, remote };
}

async function runCli(
	args: string[],
	store: string,
	envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		["--import", "tsx", "packages/her/src/cli.ts", ...args],
		{
			cwd: repoRoot,
			env: { ...process.env, HER_MEMORY_DIR: store, ...envOverrides },
		},
	);
	return { stdout, stderr };
}

async function withLocalChatModel<T>(
	reply: (prompt: string) => string,
	fn: (env: Record<string, string>, prompts: string[]) => Promise<T>,
): Promise<T> {
	const prompts: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
			const prompt = String(parsed.messages?.[0]?.content ?? "");
			prompts.push(prompt);
			let content: string;
			try {
				content = reply(prompt);
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content } }] }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address() as AddressInfo;
	try {
		return await fn(
			{
				HER_SUMMARY_BASE_URL: `http://127.0.0.1:${port}`,
				HER_SUMMARY_MODEL: "her-cli-test-model",
			},
			prompts,
		);
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
}

test("CLI reports Her memory sync status as JSON", async () => {
	const { store } = await gitBackedStore();

	let result = await runCli(["sync", "--status", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.memoryDir, store);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal(payload.status.branch, "master");
	assert.match(payload.lastSyncedAt, /^\d{4}-\d{2}-\d{2}T/);

	await new Memory(store).remember("Pending local memory for the CLI.", "note");
	result = await runCli(["sync", "--status", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.status.status, "unsynced");
	assert.equal(payload.status.dirtyFiles, 1);
	assert.equal(payload.status.pending, 1);
});

test("CLI sync commits and pushes dirty Her memory", async () => {
	const { store, remote } = await gitBackedStore();
	await new Memory(store).remember("CLI should commit and push this memory.", "note");

	const result = await runCli(["sync", "--message", "memory(sync): cli test", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.status, "pushed");
	assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): cli test/);
});

test("CLI captures a UI message through TS her-core as JSON", async () => {
	const { store } = await gitBackedStore();
	const secret = `sk-${"123456789012345678901234"}`;
	const text = `Samantha UI should capture this safely. ${secret}`;

	await withLocalChatModel(
		(prompt) => {
			assert.doesNotMatch(prompt, new RegExp(secret));
			assert.match(prompt, /«REDACTED:secret»/);
			return "- captured safely from UI";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(
				[
					"capture",
					"--text",
					text,
					"--project",
					"samantha-ui",
					"--session",
					"gui-test",
					"--timestamp",
					"2026-06-05T1200",
					"--json",
				],
				store,
				modelEnv,
			);
			const payload = JSON.parse(result.stdout);

			assert.equal(payload.result.id, "gui-test");
			assert.equal(payload.status.status, "unsynced");
			assert.equal(prompts.length, 1);
			const raw = await readFile(join(store, "episodic", "raw", "2026-06-05T1200--gui-test.md"), "utf8");
			assert.match(raw, /samantha-ui/);
			assert.doesNotMatch(raw, new RegExp(secret));
			assert.match(raw, /«REDACTED:secret»/);
			assert.match(await readFile(join(store, "episodic", "2026-06-05.md"), "utf8"), /captured safely from UI/);
		},
	);
});

test("CLI persists an intake source with recall verification as JSON", async () => {
	const { store } = await gitBackedStore();

	const result = await runCli(
		[
			"intake-source",
			"--title",
			"Agent Intake Patterns",
			"--source-url",
			"https://example.com/intake",
			"--source-type",
			"article",
			"--extracted",
			"A complete short article about source intake and recall verification.",
			"--coverage",
			"Read full short article; no sections skipped.",
			"--claim-json",
			JSON.stringify({
				claim: "Trusted writer computes content hashes.",
				verdict: "supported",
				evidence: "The fixture source describes trusted writer hash computation.",
				sourceQuality: "primary",
				caveats: "Synthetic fixture.",
			}),
			"--read",
			"The useful pattern is letting the trusted writer compute content hashes.",
			"--steal",
			"Compute content hashes in the trusted write tool",
			"--connection",
			"mirror",
			"--take",
			"This tightens the Stage 2 intake chain.",
			"--possible-move",
			"Use her intake-source from RPC shells.",
			"--memory-status",
			"needs_deep_read",
			"--json",
		],
		store,
	);
	const payload = JSON.parse(result.stdout);

	assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
	assert.match(payload.result.contentHash, /^[0-9a-f]{64}$/);
	assert.ok(payload.result.recall.some((note: { id: string }) => note.id === "world/agent-intake-patterns"));
	assert.equal(payload.status.status, "unsynced");

	const world = await readFile(join(store, "world", "agent-intake-patterns.md"), "utf8");
	assert.match(world, /memory_status: needs_deep_read/);
	assert.match(world, /claim_count: 1/);
	assert.match(world, /claim: Trusted writer computes content hashes/);
	assert.match(world, /verdict: supported/);
	assert.match(world, /recall verification/);
	assert.match(world, /\[\[mirror\]\]/);
	const seen = JSON.parse(await readFile(join(store, ".her", "seen.json"), "utf8"));
	assert.equal(seen[payload.result.contentHash], payload.result.noteId);
});

test("CLI runs TS growth maintenance commands as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n", "utf8");
	await writeFile(
		join(store, "narrative", "SAMANTHA.md"),
		"# SAMANTHA\n\nSamantha verifies before closing.\n",
		"utf8",
	);
	await writeFile(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nFei chooses proven work.\n", "utf8");
	await new Memory(store).capture("Fei prefers exact verification before reassurance.", {
		timestamp: "2026-06-05T0900",
		sessionId: "episode-cli",
		project: "her",
	});

	await withLocalChatModel(
		(prompt) => {
			if (prompt.includes("TYPED units")) {
				assert.match(prompt, /episode-cli/);
				return JSON.stringify({
					notes: [
						{
							key: "verification-over-reassurance",
							type: "opinion",
							title: "Verification over reassurance",
							content: "Fei trusts exact verification before reassurance.",
							relations: [{ to: "agent-work-style", rel: "proves" }],
							sources: ["episode-cli"],
						},
					],
					moments: [{ trigger: "completion report", shift: "Samantha should verify before reassurance" }],
				});
			}
			if (prompt.includes("Produce an UPDATED full narrative")) {
				assert.match(prompt, /GROUND-TRUTH FACTS/);
				assert.match(prompt, /SAMANTHA SELF-NARRATIVE/);
				assert.match(prompt, /CHOICE MODEL/);
				return "# CONTEXT\n\nFei values exact verification before reassurance.\n";
			}
			if (prompt.includes("Idea Engine")) {
				assert.match(prompt, /Verification Practice/);
				return JSON.stringify({
					ideas: [
						{
							title: "Verification as care",
							connects: ["verification-over-reassurance"],
							insight: "Reliable close-outs can be relational care.",
							spark: "Make every completion report show evidence first.",
							kind: "self-x-world",
						},
					],
				});
			}
			if (prompt.includes("Group these knowledge units")) {
				assert.match(prompt, /verification-over-reassurance/);
				return JSON.stringify({
					maps: [
						{
							theme: "Verification Practice",
							summary: "Machine truth before closure.",
							members: ["verification-over-reassurance"],
						},
					],
				});
			}
			throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
		},
		async (modelEnv, prompts) => {
			let result = await runCli(["consolidate", "--limit", "1", "--json"], store, modelEnv);
			let payload = JSON.parse(result.stdout);
			assert.deepEqual(payload.result, { episodes: 1, notesTouched: 1, moments: 1 });
			assert.match(
				await readFile(join(store, "semantic", "verification-over-reassurance.md"), "utf8"),
				/exact verification/,
			);

			result = await runCli(["synthesize", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.match(payload.result.proposalId, /^\d{4}-\d{2}-\d{2}-narrative-update$/);
			assert.match(await readFile(join(store, "narrative", "CONTEXT.md"), "utf8"), /exact verification/);

			result = await runCli(["topic-maps", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.deepEqual(payload.result, ["verification-practice"]);
			assert.match(await readFile(join(store, "topics", "verification-practice.md"), "utf8"), /Machine truth/);

			result = await runCli(["ideas", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.equal(payload.result[0].title, "Verification as care");
			assert.equal(payload.result[0].kind, "self-x-world");
			assert.equal(prompts.length, 4);
		},
	);
});

test("CLI reports synthesize due and approves a proposal as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }), "utf8");
	await writeFile(
		join(store, "semantic", "new-signal.md"),
		'---\nupdated: 2026-06-02\nrelations:\n  - {"to":"old-rule","rel":"conflicts"}\n---\n# New Signal\n\nA conflict should trigger synthesis.\n',
		"utf8",
	);
	await writeFile(join(store, "proposals", "manual.md"), "# CONTEXT\n\nManual proposal from CLI.\n", "utf8");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: due and proposal fixtures");

	let result = await runCli(["synthesize-due", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.result.due, true);
	assert.equal(payload.result.reason, "conflict");

	result = await runCli(["approve", "--proposal", "manual", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result, { proposalId: "manual", approved: true });
	assert.match(await readFile(join(store, "narrative", "CONTEXT.md"), "utf8"), /Manual proposal from CLI/);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(context\): Approve proposal manual/);
});

test("CLI runs governed archive sweep as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "semantic", "old-noise.md"),
		"---\ntier: decay\nupdated: 2020-01-01\n---\n# Old noise\n\nStale low-value memory.\n",
		"utf8",
	);
	await writeFile(
		join(store, "semantic", "identity.md"),
		"---\ntier: exact\nupdated: 2020-01-01\n---\n# Identity\n\nNever archive exact memory.\n",
		"utf8",
	);

	const result = await runCli(["decay", "--older-than-days", "30", "--now", "2026-06-05", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result.archivedKeys, ["old-noise"]);
	assert.equal(payload.result.archived, 1);
	assert.match(await readFile(join(store, "archive", "semantic", "old-noise.md"), "utf8"), /archived_at: 2026-06-05/);
	assert.match(await readFile(join(store, "semantic", "identity.md"), "utf8"), /Never archive exact memory/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});

test("CLI synthesizes choice model as JSON", async () => {
	const { store } = await gitBackedStore();
	const memory = new Memory(store);
	const noteId = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror-timing",
		sourceType: "article",
		contentHash: "choice-model-cli-fixture",
		memoryStatus: "active",
		extracted: "Fei rejected noisy proactive interruptions.",
		coverage: "Read full short fixture.",
		read: "The source argues timing matters more than volume.",
		steal: ["Quiet timing beats frequent interruption."],
		connections: ["[[semantic/mirror]]"],
		take: "Samantha should wait for high-signal moments.",
		possibleMoves: ["Prefer fewer proactive messages."],
	});
	await memory.recordJudgment(noteId, {
		choice: "Prefer quiet high-signal prompts",
		correction: "Do not treat every related memory as worth interrupting Fei.",
	});
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: choice evidence");

	await withLocalChatModel(
		(prompt) => {
			assert.match(prompt, /CHOICE MODEL/);
			assert.match(prompt, /Prefer quiet high-signal prompts/);
			return "# CHOICE MODEL\n\nPrefer quiet high-signal prompts before interrupting Fei.\n";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(["choice-model", "--json"], store, modelEnv);
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.id, /^[0-9a-f]{8}$/);
			assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
			assert.equal(payload.status.status, "unsynced");
			assert.match(await readFile(join(store, "narrative", "CHOICE-MODEL.md"), "utf8"), /quiet high-signal/);
			assert.match(
				await readFile(join(store, "narrative", "choice-model-log.md"), "utf8"),
				/\[\[world\/mirror-timing\]\]/,
			);
			assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(choice\): Synthesize choice model/);
			assert.equal(prompts.length, 1);
		},
	);
});

test("CLI synthesizes Samantha self narrative as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "narrative", "becoming-moments.md"),
		"- 2026-06-05 · trigger: Fei asked for machine truth · shift: Samantha should verify before reassurance\n",
		"utf8",
	);
	await writeFile(
		join(store, "recognitions", "machine-truth-care.md"),
		"---\nid: rec-cli\nstatus: new\n---\n# Machine Truth Care\n\nVerification helped Fei feel the project was less chaotic.\n",
		"utf8",
	);
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: self evidence");

	await withLocalChatModel(
		(prompt) => {
			assert.match(prompt, /SAMANTHA SELF-EVIDENCE/);
			assert.match(prompt, /Machine Truth Care/);
			return "# SAMANTHA\n\nSamantha treats verification as part of care, not a separate ritual.\n";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(["self-narrative", "--json"], store, modelEnv);
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.id, /^[0-9a-f]{8}$/);
			assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
			assert.equal(payload.status.status, "unsynced");
			assert.match(await readFile(join(store, "narrative", "SAMANTHA.md"), "utf8"), /verification as part of care/);
			const log = await readFile(join(store, "narrative", "self-narrative-log.md"), "utf8");
			assert.match(log, /\[\[narrative\/becoming-moments\]\]/);
			assert.match(log, /\[\[recognitions\/machine-truth-care\]\]/);
			assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(self\): Synthesize self narrative/);
			assert.equal(prompts.length, 1);
		},
	);
});

test("CLI restores an archived semantic note as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "archive", "semantic", "old-noise.md"),
		"---\ntier: archive\npre_archive_tier: decay\narchived_at: 2026-06-05\n---\n# Old noise\n\nRestore this memory.\n",
		"utf8",
	);

	const result = await runCli(["restore", "--semantic", "old-noise", "--now", "2026-06-06", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result, { key: "old-noise", restored: true });
	assert.match(await readFile(join(store, "semantic", "old-noise.md"), "utf8"), /restored_at: 2026-06-06/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});
