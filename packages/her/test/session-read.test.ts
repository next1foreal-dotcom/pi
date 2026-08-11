import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runHerCli } from "../src/cli.ts";
import {
	formatSessionRead,
	readSession,
	resolveSessionReadConfig,
	SESSION_READ_MAX_CANDIDATES,
	SESSION_READ_MAX_RECORDS,
	type SessionReadConfig,
} from "../src/her-core/session-read.ts";

const CLAUDE_ID = "aaaa1111-0000-0000-0000-000000000001";
const CODEX_ID = "bbbb2222-0000-0000-0000-000000000002";
const CURSOR_ID = "cccc3333-0000-0000-0000-000000000003";
const PI_ID = "dddd4444-0000-0000-0000-000000000004";

async function writeLines(file: string, lines: string[], trailingNewline = true): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, lines.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
}

/** Build a temp workspace with one session per active source + archive root. */
async function makeWorkspace(): Promise<{ config: SessionReadConfig; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "her-session-read-"));
	const config: SessionReadConfig = {
		claudeDir: join(root, "claude", "projects"),
		codexDir: join(root, "codex", "sessions"),
		cursorDir: join(root, "cursor", "projects"),
		piDir: join(root, "pi", "sessions"),
		archiveDir: join(root, "archive"),
	};

	await writeLines(join(config.claudeDir, "D--proj", `${CLAUDE_ID}.jsonl`), [
		`{"type":"user","timestamp":"2026-08-11T00:00:01.000Z","cwd":"D:/proj","message":{"role":"user","content":"hello there"}}`,
		`{"type":"assistant","timestamp":"2026-08-11T00:00:02.000Z","message":{"role":"assistant","content":"secretreply"}}`,
	]);
	await writeLines(join(config.codexDir, "2026", "08", "11", `rollout-2026-08-11T00-00-00-${CODEX_ID}.jsonl`), [
		`{"timestamp":"2026-08-11T00:00:00.000Z","type":"session_meta","payload":{"session_id":"${CODEX_ID}","cwd":"D:/codexproj"}}`,
		`{"timestamp":"2026-08-11T00:00:01.000Z","type":"event_msg","payload":{"type":"task_started"}}`,
	]);
	await writeLines(join(config.cursorDir, "d-proj", "agent-transcripts", CURSOR_ID, `${CURSOR_ID}.jsonl`), [
		`{"type":"turn_started","timestamp":"2026-08-11T00:00:00.000Z"}`,
		`{"type":"turn_ended","status":"ok"}`,
	]);
	await writeLines(join(config.piDir, "--D--proj--", `2026-08-05T06-54-47-861Z_${PI_ID}.jsonl`), [
		`{"type":"session","version":3,"id":"${PI_ID}","timestamp":"2026-08-05T06:54:47.861Z","cwd":"D:/piproj"}`,
		`{"type":"model_change","id":"x","parentId":null,"timestamp":"2026-08-05T06:54:58.037Z"}`,
	]);
	return { config, root };
}

test("resolves each harness source by full id and meta hides record content", async () => {
	const { config } = await makeWorkspace();
	const cases: Array<[string, string]> = [
		[CLAUDE_ID, "claude"],
		[CODEX_ID, "codex"],
		[CURSOR_ID, "cursor"],
		[PI_ID, "pi"],
	];
	for (const [id, source] of cases) {
		const result = await readSession({ id, env: {}, config });
		assert.equal(result.status, "meta", `${source} should resolve to meta`);
		if (result.status !== "meta") continue;
		assert.equal(result.source, source);
		assert.equal(result.records, 2);
		// meta must never dump conversation content.
		assert.ok(!JSON.stringify(result).includes("secretreply"), "meta leaked record content");
		assert.ok(!JSON.stringify(result).includes("hello there"), "meta leaked record content");
	}
});

test("meta reports cwd/timestamps from the transcript header", async () => {
	const { config } = await makeWorkspace();
	const result = await readSession({ id: CODEX_ID, env: {}, config });
	assert.equal(result.status, "meta");
	if (result.status !== "meta") return;
	assert.equal(result.cwd, "D:/codexproj");
	assert.equal(result.firstTimestamp, "2026-08-11T00:00:00.000Z");
	assert.equal(result.lastTimestamp, "2026-08-11T00:00:01.000Z");
});

test("a unique id-prefix resolves to one session", async () => {
	const { config } = await makeWorkspace();
	const result = await readSession({ id: "dddd4444", env: {}, config });
	assert.equal(result.status, "meta");
	if (result.status === "meta") assert.equal(result.source, "pi");
});

test("an ambiguous prefix lists candidates instead of guessing", async () => {
	const { config } = await makeWorkspace();
	await writeLines(join(config.claudeDir, "D--proj", "dupdup-a.jsonl"), [`{"type":"user","timestamp":"t"}`]);
	await writeLines(join(config.claudeDir, "D--proj", "dupdup-b.jsonl"), [`{"type":"user","timestamp":"t"}`]);
	const result = await readSession({ id: "dupdup", env: {}, config });
	assert.equal(result.status, "ambiguous");
	if (result.status !== "ambiguous") return;
	assert.equal(result.candidates.length, 2);
	const ids = result.candidates.map((c) => c.id).sort();
	assert.deepEqual(ids, ["dupdup-a", "dupdup-b"]);
});

test("an ambiguous flood is capped with a total count", async () => {
	const { config } = await makeWorkspace();
	for (let i = 0; i < 30; i++) {
		await writeLines(join(config.claudeDir, "D--proj", `flood-${String(i).padStart(2, "0")}.jsonl`), [
			`{"type":"user","timestamp":"t"}`,
		]);
	}
	const result = await readSession({ id: "flood-", env: {}, config });
	assert.equal(result.status, "ambiguous");
	if (result.status !== "ambiguous") return;
	assert.equal(result.totalCandidates, 30);
	assert.equal(result.candidates.length, SESSION_READ_MAX_CANDIDATES);
	const text = formatSessionRead(result);
	assert.ok(text.includes("30"), "formatter should state the total match count");
	assert.ok(/narrow/i.test(text), "formatter should tell the caller to narrow the id");
});

test("unknown id returns not_found with the searched dirs", async () => {
	const { config } = await makeWorkspace();
	const result = await readSession({ id: "no-such-session", env: {}, config });
	assert.equal(result.status, "not_found");
	if (result.status !== "not_found") return;
	assert.ok(result.searched.includes(config.piDir));
	assert.ok(result.searched.includes(config.archiveDir));
});

test("blank id throws", async () => {
	await assert.rejects(() => readSession({ id: "   ", env: {}, config: {} }), /session id is required/);
});

test("head/tail/slice page records with stable offsets", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-page-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const lines = Array.from(
		{ length: 250 },
		(_, i) => `{"i":${i},"timestamp":"2026-08-11T00:00:${String(i % 60).padStart(2, "0")}.000Z"}`,
	);
	await writeLines(join(root, "claude", "slug", "page1111-aaaa.jsonl"), lines);

	const head = await readSession({ id: "page1111-aaaa", env: {}, config, mode: { kind: "head", count: 3 } });
	assert.equal(head.status, "records");
	if (head.status !== "records") return;
	assert.equal(head.returned, 3);
	assert.equal(head.offset, 0);
	assert.equal(head.totalRecords, 250);
	assert.ok(head.records[0].raw.includes(`"i":0`));

	const slice = await readSession({
		id: "page1111-aaaa",
		env: {},
		config,
		mode: { kind: "slice", offset: 100, limit: 2 },
	});
	assert.equal(slice.status, "records");
	if (slice.status !== "records") return;
	assert.equal(slice.offset, 100);
	assert.equal(slice.returned, 2);
	assert.ok(slice.records[0].raw.includes(`"i":100`));

	const tail = await readSession({ id: "page1111-aaaa", env: {}, config, mode: { kind: "tail", count: 2 } });
	assert.equal(tail.status, "records");
	if (tail.status !== "records") return;
	assert.equal(tail.offset, 248);
	assert.ok(tail.records[1].raw.includes(`"i":249`));
});

test("record-count hard cap truncates and points at the next offset", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-cap-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const lines = Array.from({ length: 250 }, (_, i) => `{"i":${i}}`);
	await writeLines(join(root, "claude", "slug", "cap1111-aaaa.jsonl"), lines);

	const result = await readSession({ id: "cap1111-aaaa", env: {}, config, mode: { kind: "head", count: 300 } });
	assert.equal(result.status, "records");
	if (result.status !== "records") return;
	assert.equal(result.returned, SESSION_READ_MAX_RECORDS);
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedReason, "count");
	assert.equal(result.nextOffset, SESSION_READ_MAX_RECORDS);
	assert.equal(result.remaining, 50);
	// The truncation note tells the caller how to page for the rest.
	assert.match(formatSessionRead(result), /truncated.*--slice 200/);
});

test("byte hard cap truncates the window", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-bytes-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const big = "x".repeat(2000);
	const lines = Array.from({ length: 10 }, (_, i) => `{"i":${i},"blob":"${big}"}`);
	await writeLines(join(root, "claude", "slug", "byte1111-aaaa.jsonl"), lines);

	const result = await readSession({
		id: "byte1111-aaaa",
		env: {},
		config,
		mode: { kind: "head", count: 10 },
		maxBytes: 5000,
	});
	assert.equal(result.status, "records");
	if (result.status !== "records") return;
	assert.equal(result.truncatedReason, "bytes");
	assert.ok(result.returned >= 1 && result.returned < 10);
});

test("a single oversized record is clipped to the byte cap", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-huge-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const huge = "y".repeat(100_000);
	await writeLines(join(root, "claude", "slug", "huge1111-aaaa.jsonl"), [`{"blob":"${huge}"}`]);

	const result = await readSession({
		id: "huge1111-aaaa",
		env: {},
		config,
		mode: { kind: "head", count: 1 },
		maxBytes: 1000,
	});
	assert.equal(result.status, "records");
	if (result.status !== "records") return;
	assert.equal(result.returned, 1);
	assert.equal(result.records[0].rawTruncated, true);
	assert.ok(Buffer.byteLength(result.records[0].raw, "utf8") <= 1000);
});

test("grep returns matches plus context and counts them", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-grep-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const lines = [
		`{"i":0,"text":"nothing"}`,
		`{"i":1,"text":"NEEDLE one"}`,
		`{"i":2,"text":"after"}`,
		`{"i":3,"text":"nothing"}`,
		`{"i":4,"text":"NEEDLE two"}`,
	];
	await writeLines(join(root, "claude", "slug", "grep1111-aaaa.jsonl"), lines);

	const result = await readSession({
		id: "grep1111-aaaa",
		env: {},
		config,
		mode: { kind: "grep", pattern: "NEEDLE", context: 1 },
	});
	assert.equal(result.status, "records");
	if (result.status !== "records") return;
	assert.equal(result.matches, 2);
	const shown = result.records.map((r) => r.raw).join("\n");
	assert.ok(shown.includes("NEEDLE one"));
	assert.ok(shown.includes("NEEDLE two"));
	assert.ok(shown.includes(`"i":2`)); // context record between/after matches
});

test("a growing file is read without lock and a half-written trailing line is tolerated", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-session-grow-"));
	const config: Partial<SessionReadConfig> = { claudeDir: join(root, "claude") };
	const file = join(root, "claude", "slug", "grow1111-aaaa.jsonl");

	// First snapshot: two complete records + a half-written third line (no newline).
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `{"a":1}\n{"b":2}\n{"c":3`, "utf8");
	const first = await readSession({ id: "grow1111-aaaa", env: {}, config });
	assert.equal(first.status, "meta");
	if (first.status !== "meta") return;
	assert.equal(first.records, 2);
	assert.equal(first.partialTrailing, true);

	// Writer completes the partial line and appends another record.
	await writeFile(file, `{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n`, "utf8");
	const second = await readSession({ id: "grow1111-aaaa", env: {}, config });
	assert.equal(second.status, "meta");
	if (second.status !== "meta") return;
	assert.equal(second.records, 4);
	assert.notEqual(second.partialTrailing, true);
});

test("archive fallback matches by filename when no active source has the id", async () => {
	const { config } = await makeWorkspace();
	const archiveId = "archived-9999";
	await writeLines(join(config.archiveDir, "episodic", "raw", `2026-08-11--capture-${archiveId}.md`), [
		`{"note":"harvested capture, not a full transcript"}`,
	]);
	const result = await readSession({ id: archiveId, env: {}, config });
	assert.equal(result.status, "meta");
	if (result.status === "meta") assert.equal(result.source, "archive");
});

test("resolveSessionReadConfig reads per-source env overrides", async () => {
	const { config } = await makeWorkspace();
	const env: NodeJS.ProcessEnv = {
		HER_CLAUDE_SESSIONS_DIR: config.claudeDir,
		HER_CODEX_SESSIONS_DIR: config.codexDir,
		HER_CURSOR_PROJECTS_DIR: config.cursorDir,
		HER_PI_SESSIONS_DIR: config.piDir,
		HER_MEMORY_DIR: config.archiveDir,
	};
	const resolved = resolveSessionReadConfig(env, "C:/nonexistent-home");
	assert.equal(resolved.piDir, config.piDir);
	// End-to-end through the env path (no config override): resolves the pi session.
	const result = await readSession({ id: PI_ID, env });
	assert.equal(result.status, "meta");
	if (result.status === "meta") assert.equal(result.source, "pi");
});

test("CLI: her session <id> --json returns meta and exit 0; unknown id exits 1", async () => {
	const { config } = await makeWorkspace();
	const env: NodeJS.ProcessEnv = {
		HER_CLAUDE_SESSIONS_DIR: config.claudeDir,
		HER_CODEX_SESSIONS_DIR: config.codexDir,
		HER_CURSOR_PROJECTS_DIR: config.cursorDir,
		HER_PI_SESSIONS_DIR: config.piDir,
		HER_MEMORY_DIR: config.archiveDir,
	};
	const out = collector();
	const code = await runHerCli(["session", CLAUDE_ID, "--json"], env, process.cwd(), {
		stdout: out.stream,
		stderr: collector().stream,
	});
	assert.equal(code, 0);
	const payload = JSON.parse(out.text);
	assert.equal(payload.result.status, "meta");
	assert.equal(payload.result.source, "claude");

	const missing = collector();
	const missingCode = await runHerCli(["session", "does-not-exist"], env, process.cwd(), {
		stdout: missing.stream,
		stderr: collector().stream,
	});
	assert.equal(missingCode, 1);
	assert.match(missing.text, /No session matched/);
});

function collector(): { stream: NodeJS.WritableStream; readonly text: string } {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
	} as unknown as NodeJS.WritableStream;
	return {
		stream,
		get text() {
			return chunks.join("");
		},
	};
}
