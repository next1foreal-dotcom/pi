import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyWaitingEntry,
	emptyWaitingLedger,
	outboxFileName,
	parseSessionWaiting,
	parseWaitingLedger,
	planWaitingOutbox,
	renderWaitingMessage,
	type SessionWaiting,
	scanWaitingOutbox,
	sessionDirFromEnv,
	type WaitingRequest,
	waitingHash,
	waitingKey,
	waitingLedgerPath,
} from "../src/her-core/waiting-outbox.ts";

const NOW = "2026-09-05T19:30:00.000Z";

/**
 * Copied byte-for-byte out of the real session
 * `2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl` (line 23), so the parser
 * is pinned to what she actually emits, not to what we imagine she emits.
 */
const REAL_WAITING: WaitingRequest = {
	options: ["瘦，信息密度再压一档", "不瘦，现在这档刚好"],
	question: "弹层要不要再瘦一档？",
};
const REAL_HEADLINE = "G-425 deck 联调中，卡在弹层密度一档";
const REAL_NAME = "deck 联调 G-425";

function sessionHeader(id: string): string {
	return JSON.stringify({
		cwd: "D:\\@Her\\Her-repo\\samantha",
		id,
		timestamp: "2026-09-05T19:23:18.372Z",
		type: "session",
		version: 3,
	});
}

function modelChange(): string {
	return JSON.stringify({
		id: "b5fbd281",
		modelId: "deepseek-v4-flash",
		parentId: null,
		provider: "deepseek",
		timestamp: "2026-09-05T19:23:19.492Z",
		type: "model_change",
	});
}

/** Same envelope shape as the real file: assistant message, thinking part, then the toolCall. */
function statusCall(args: Record<string, unknown>, index = 0): string {
	return JSON.stringify({
		id: `msg-${index}`,
		message: {
			content: [
				{ thinking: "…", thinkingSignature: "reasoning_content", type: "thinking" },
				{ arguments: args, id: `call_00_${index}`, name: "her_status", type: "toolCall" },
			],
			role: "assistant",
			timestamp: 1788636373373,
		},
		parentId: "e5eed698",
		timestamp: "2026-09-05T19:26:14.886Z",
		type: "message",
	});
}

function otherToolCall(name: string, index = 90): string {
	return JSON.stringify({
		id: `msg-${index}`,
		message: {
			content: [{ arguments: { path: "." }, id: `call_00_${index}`, name, type: "toolCall" }],
			role: "assistant",
		},
		type: "message",
	});
}

function userTurn(text: string, index = 5): string {
	return JSON.stringify({
		id: `user-${index}`,
		message: { content: [{ text, type: "text" }], role: "user" },
		type: "message",
	});
}

function jsonl(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

/** A session that ends on a real waiting — the "should push" side. */
function waitingSessionText(id = "deck-lian-tiao-g425"): string {
	return jsonl(
		sessionHeader(id),
		modelChange(),
		userTurn("请调用 her_status 起名『deck 联调 G-425』"),
		statusCall({ headline: "开始 G-425 deck 联调，先读任务上下文", name: REAL_NAME }, 1),
		otherToolCall("ls"),
		statusCall({ headline: REAL_HEADLINE, waiting: REAL_WAITING }, 2),
	);
}

function sample(overrides: Partial<SessionWaiting> = {}): SessionWaiting {
	return {
		file: "2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl",
		headline: REAL_HEADLINE,
		name: REAL_NAME,
		sessionId: "deck-lian-tiao-g425",
		waiting: REAL_WAITING,
		...overrides,
	};
}

async function tempDirs(): Promise<{ memoryRoot: string; sessionDir: string }> {
	const base = await mkdtemp(join(tmpdir(), "her-waiting-outbox-"));
	const sessionDir = join(base, ".pi-sessions");
	const memoryRoot = join(base, "memory");
	await mkdir(sessionDir, { recursive: true });
	await mkdir(memoryRoot, { recursive: true });
	return { memoryRoot, sessionDir };
}

async function listOutbox(memoryRoot: string): Promise<string[]> {
	try {
		return (await readdir(join(memoryRoot, "outbox"))).filter((name) => name.endsWith(".md")).sort();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

// ---------------------------------------------------------------- parsing

test("parses the real her_status shape and carries her session name forward", () => {
	const parsed = parseSessionWaiting("2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl", waitingSessionText());
	assert.ok(parsed, "expected the waiting session to parse");
	assert.equal(parsed.sessionId, "deck-lian-tiao-g425");
	assert.equal(parsed.headline, REAL_HEADLINE);
	// She only sends `name` on the first call; the last call has none.
	assert.equal(parsed.name, REAL_NAME);
	assert.equal(parsed.waiting.question, REAL_WAITING.question);
	assert.deepEqual(parsed.waiting.options, REAL_WAITING.options);
});

test("falls back to the deck's filename-derived id when the session header is missing", () => {
	const text = jsonl(statusCall({ headline: REAL_HEADLINE, waiting: REAL_WAITING }, 2));
	const parsed = parseSessionWaiting("2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl", text);
	assert.ok(parsed);
	assert.equal(parsed.sessionId, "deck-lian-tiao-g425");
});

test("a truncated trailing line does not lose the waiting before it", () => {
	const text = `${waitingSessionText()}{"type":"message","id":"half`;
	const parsed = parseSessionWaiting("live.jsonl", text);
	assert.ok(parsed, "a half-written last line must not drop the whole session");
	assert.equal(parsed.waiting.question, REAL_WAITING.question);
});

test("NOT waiting: her last her_status carries no waiting", () => {
	// This is the real `live-ask-demo` shape: three her_status calls, none waiting.
	const text = jsonl(
		sessionHeader("live-ask-demo"),
		statusCall({ headline: "deck 联调探针已回应", name: "deck 联调 G-425 人到了" }, 1),
		statusCall({ headline: "验证 her_status 能不能打通", name: "第七波通告完成" }, 2),
	);
	assert.equal(parseSessionWaiting("live-ask-demo.jsonl", text), null);
});

test("NOT waiting: she was waiting earlier but her last call dropped it", () => {
	const text = jsonl(
		sessionHeader("s1"),
		statusCall({ headline: REAL_HEADLINE, waiting: REAL_WAITING }, 1),
		statusCall({ headline: "拍板收到，继续干" }, 2),
	);
	assert.equal(parseSessionWaiting("s1.jsonl", text), null);
});

test("NOT waiting: she never called her_status at all", () => {
	const text = jsonl(sessionHeader("s2"), modelChange(), otherToolCall("ls"), userTurn("干活"));
	assert.equal(parseSessionWaiting("s2.jsonl", text), null);
});

test("NOT waiting: the waiting block has no real question", () => {
	for (const waiting of [{}, { question: "   " }, { options: ["a"] }, { question: null }]) {
		const text = jsonl(sessionHeader("s3"), statusCall({ headline: "x", waiting }, 1));
		assert.equal(parseSessionWaiting("s3.jsonl", text), null, `expected no waiting for ${JSON.stringify(waiting)}`);
	}
});

test("a waiting with no options still counts", () => {
	const text = jsonl(sessionHeader("s4"), statusCall({ headline: "x", waiting: { question: "走哪条？" } }, 1));
	const parsed = parseSessionWaiting("s4.jsonl", text);
	assert.ok(parsed);
	assert.deepEqual(parsed.waiting.options, []);
});

test("blank option strings are dropped, real ones kept in order", () => {
	const waiting = { options: ["  甲  ", "", "   ", "乙"], question: "选哪个？" };
	const text = jsonl(sessionHeader("s5"), statusCall({ headline: "x", waiting }, 1));
	const parsed = parseSessionWaiting("s5.jsonl", text);
	assert.ok(parsed);
	assert.deepEqual(parsed.waiting.options, ["甲", "乙"]);
});

// ---------------------------------------------------------------- idempotency key

test("the key changes when the question changes, and only then", () => {
	const base = waitingKey("s", REAL_WAITING);
	assert.equal(base, waitingKey("s", { ...REAL_WAITING, options: [...REAL_WAITING.options] }));
	assert.notEqual(base, waitingKey("s", { ...REAL_WAITING, question: "别的问题？" }));
	assert.notEqual(base, waitingKey("s", { ...REAL_WAITING, options: ["瘦", "不瘦"] }));
	assert.notEqual(base, waitingKey("s", { ...REAL_WAITING, options: [...REAL_WAITING.options].reverse() }));
	assert.notEqual(base, waitingKey("other-session", REAL_WAITING));
	assert.ok(base.startsWith("s#"), `key should be scoped by session id, got ${base}`);
	assert.match(waitingHash(REAL_WAITING), /^[0-9a-f]{12}$/);
});

test("option boundaries cannot be smudged into a colliding key", () => {
	const a: WaitingRequest = { options: ["ab", "c"], question: "q" };
	const b: WaitingRequest = { options: ["a", "bc"], question: "q" };
	assert.notEqual(waitingKey("s", a), waitingKey("s", b));
});

// ---------------------------------------------------------------- ledger

test("an absent ledger reads as empty; a corrupt one is loud", () => {
	assert.deepEqual(parseWaitingLedger(undefined), emptyWaitingLedger());
	assert.deepEqual(parseWaitingLedger("   "), emptyWaitingLedger());
	assert.throws(() => parseWaitingLedger("{not json"), /ledger/i);
	assert.throws(() => parseWaitingLedger('{"version":1}'), /ledger/i);
	assert.throws(() => parseWaitingLedger('{"version":1,"notified":[]}'), /ledger/i);
	assert.throws(() => parseWaitingLedger('"nope"'), /ledger/i);
});

test("a ledger round-trips through its own JSON", () => {
	const entry = planWaitingOutbox([sample()], emptyWaitingLedger(), NOW).entries[0];
	assert.ok(entry);
	const ledger = applyWaitingEntry(emptyWaitingLedger(), entry);
	assert.deepEqual(parseWaitingLedger(JSON.stringify(ledger)), ledger);
});

// ---------------------------------------------------------------- planning (both sides)

test("SHOULD push: a fresh waiting with an empty ledger produces exactly one entry", () => {
	const plan = planWaitingOutbox([sample()], emptyWaitingLedger(), NOW);
	assert.equal(plan.entries.length, 1);
	assert.equal(plan.skipped.length, 0);
	const [entry] = plan.entries;
	assert.equal(entry.sessionId, "deck-lian-tiao-g425");
	assert.equal(entry.key, waitingKey("deck-lian-tiao-g425", REAL_WAITING));
	assert.match(entry.file, /\.md$/);
	assert.ok(plan.ledger.notified[entry.key], "the planned ledger must remember the key");
	assert.equal(plan.ledger.notified[entry.key].notifiedAt, NOW);
});

test("NOT push: the same waiting already in the ledger produces nothing", () => {
	const first = planWaitingOutbox([sample()], emptyWaitingLedger(), NOW);
	const second = planWaitingOutbox([sample()], first.ledger, "2026-09-05T20:00:00.000Z");
	assert.equal(second.entries.length, 0, "the same waiting must not be pushed twice");
	assert.equal(second.skipped.length, 1);
	assert.match(second.skipped[0].reason, /already/i);
	assert.deepEqual(second.ledger, first.ledger, "a skipped session must not move the ledger");
});

test("NOT push: nothing is waiting", () => {
	const plan = planWaitingOutbox([], emptyWaitingLedger(), NOW);
	assert.equal(plan.entries.length, 0);
	assert.equal(plan.skipped.length, 0);
});

test("SHOULD push again: she changed the question", () => {
	const first = planWaitingOutbox([sample()], emptyWaitingLedger(), NOW);
	const changed = sample({ waiting: { options: [], question: "改主意了，直接砍掉行不行？" } });
	const second = planWaitingOutbox([changed], first.ledger, "2026-09-05T20:00:00.000Z");
	assert.equal(second.entries.length, 1);
	assert.equal(Object.keys(second.ledger.notified).length, 2);
});

test("two sessions waiting at once get two entries with distinct file names", () => {
	const other = sample({ file: "other.jsonl", name: undefined, sessionId: "steer-probe-g380" });
	const plan = planWaitingOutbox([sample(), other], emptyWaitingLedger(), NOW);
	assert.equal(plan.entries.length, 2);
	assert.equal(new Set(plan.entries.map((entry) => entry.file)).size, 2);
});

test("the outbox file name is filesystem-safe and sorts by time", () => {
	const name = outboxFileName("deck 联调/G-425", "abcdef123456", NOW);
	assert.match(name, /^2026-09-05T19-30-00-000Z-waiting-.*-abcdef123456\.md$/);
	assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

// ---------------------------------------------------------------- message body

test("the message carries name, headline, question, numbered options and the session id", () => {
	const body = renderWaitingMessage(sample());
	assert.ok(body.includes(REAL_NAME), body);
	assert.ok(body.includes(REAL_HEADLINE), body);
	assert.ok(body.includes(REAL_WAITING.question), body);
	assert.ok(body.includes(`1. ${REAL_WAITING.options[0]}`), body);
	assert.ok(body.includes(`2. ${REAL_WAITING.options[1]}`), body);
	assert.ok(body.includes("deck-lian-tiao-g425"), body);
});

test("no name falls back to the session id, and no options means no numbered list", () => {
	const body = renderWaitingMessage(sample({ name: undefined, waiting: { options: [], question: "走哪条？" } }));
	assert.ok(body.includes("deck-lian-tiao-g425"), body);
	assert.doesNotMatch(body, /^1\. /m);
});

test("an oversized message is trimmed to Telegram's limit", () => {
	const body = renderWaitingMessage(sample({ headline: "长".repeat(9000) }));
	assert.ok(body.length <= 4096, `body was ${body.length} chars`);
	assert.ok(body.includes("[trimmed for Telegram message limit]"), "must use the repo's own trimmer");
});

// ---------------------------------------------------------------- session dir resolution

test("session dir follows the deck's own convention", () => {
	assert.equal(sessionDirFromEnv({ HER_PI_SESSION_DIR: join(tmpdir(), "explicit") }), join(tmpdir(), "explicit"));
	assert.equal(sessionDirFromEnv({ HER_BUILD_DIR: "D:\\builds" }), join("D:\\builds", ".pi-sessions"));
	assert.equal(sessionDirFromEnv({}), join(tmpdir(), "samantha-builds", ".pi-sessions"));
});

test("the ledger is a dot file at the memory root, never inside the outbox", () => {
	const path = waitingLedgerPath(join(tmpdir(), "mem"));
	assert.equal(path, join(tmpdir(), "mem", ".waiting-outbox.json"));
	assert.doesNotMatch(path, /outbox[\\/]/);
});

// ---------------------------------------------------------------- end to end, on disk

test("scan writes one outbox item, and a second scan writes none", async () => {
	const { memoryRoot, sessionDir } = await tempDirs();
	await writeFile(
		join(sessionDir, "2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl"),
		waitingSessionText(),
		"utf8",
	);
	await writeFile(
		join(sessionDir, "2026-08-31T21-34-36-346Z_live-ask-demo.jsonl"),
		jsonl(sessionHeader("live-ask-demo"), statusCall({ headline: "干完了", name: "第七波通告完成" }, 1)),
		"utf8",
	);

	const first = await scanWaitingOutbox({ memoryRoot, now: NOW, sessionDir });
	assert.equal(first.scanned, 2);
	assert.equal(first.waiting, 1);
	assert.equal(first.written.length, 1);
	assert.deepEqual(first.warnings, []);

	const files = await listOutbox(memoryRoot);
	assert.equal(files.length, 1, `expected exactly one outbox item, got ${JSON.stringify(files)}`);
	const body = await readFile(join(memoryRoot, "outbox", files[0]), "utf8");
	assert.ok(body.includes(REAL_WAITING.question), body);
	assert.ok(body.includes("deck-lian-tiao-g425"), body);

	const second = await scanWaitingOutbox({ memoryRoot, now: "2026-09-05T21:00:00.000Z", sessionDir });
	assert.equal(second.written.length, 0, "the second run must not re-push the same waiting");
	assert.equal(second.skipped.length, 1);
	assert.deepEqual(await listOutbox(memoryRoot), files, "the outbox must be untouched on the second run");
});

test("scan never writes the ledger into the outbox", async () => {
	const { memoryRoot, sessionDir } = await tempDirs();
	await writeFile(join(sessionDir, "a_deck-lian-tiao-g425.jsonl"), waitingSessionText(), "utf8");
	await scanWaitingOutbox({ memoryRoot, now: NOW, sessionDir });
	const ledger = JSON.parse(await readFile(waitingLedgerPath(memoryRoot), "utf8"));
	assert.equal(Object.keys(ledger.notified).length, 1);
	assert.deepEqual(await readdir(join(memoryRoot, "outbox")), await listOutbox(memoryRoot));
});

test("one unreadable session warns but does not stop the round", async () => {
	const { memoryRoot, sessionDir } = await tempDirs();
	await writeFile(join(sessionDir, "broken.jsonl"), "\u0000\u0000not json at all", "utf8");
	await writeFile(
		join(sessionDir, "2026-09-05T19-23-18-372Z_deck-lian-tiao-g425.jsonl"),
		waitingSessionText(),
		"utf8",
	);
	const result = await scanWaitingOutbox({ memoryRoot, now: NOW, sessionDir });
	assert.equal(result.written.length, 1, "a broken neighbour must not cost us the real waiting");
	assert.equal(result.warnings.length, 1, JSON.stringify(result.warnings));
	assert.match(result.warnings[0], /broken\.jsonl/);
});

test("a missing session directory is loud, not silent", async () => {
	const { memoryRoot } = await tempDirs();
	await assert.rejects(
		() => scanWaitingOutbox({ memoryRoot, now: NOW, sessionDir: join(tmpdir(), "her-waiting-does-not-exist-9f3a") }),
		/session/i,
	);
});

test("a corrupt ledger is loud, and nothing gets pushed on top of it", async () => {
	const { memoryRoot, sessionDir } = await tempDirs();
	await writeFile(join(sessionDir, "a_deck-lian-tiao-g425.jsonl"), waitingSessionText(), "utf8");
	await writeFile(waitingLedgerPath(memoryRoot), "{ this is not json", "utf8");
	await assert.rejects(() => scanWaitingOutbox({ memoryRoot, now: NOW, sessionDir }), /ledger/i);
	assert.deepEqual(await listOutbox(memoryRoot), []);
});
