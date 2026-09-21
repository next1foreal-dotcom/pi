import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	appendContextManifestRecord,
	appendInjectionRecord,
	applyBlockDedupe,
	buildContextManifest,
	contentDigest,
	estimateInjectionTokens,
	injectionLedgerPath,
	injectLoggedContent,
	isInjectDedupeEnabled,
	resetInjectionDedupeState,
	selectTurnContext,
	unchangedInjectionMarker,
} from "../src/lib/injection-ledger.ts";

async function tempStore(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "her-inject-ledger-"));
}

test("contentDigest is 16-char sha256 hex", () => {
	const digest = contentDigest("her-context body");
	assert.match(digest, /^[0-9a-f]{16}$/);
	assert.equal(digest, contentDigest("her-context body"));
	assert.notEqual(digest, contentDigest("other body"));
});

test("appendInjectionRecord writes JSONL with the specified shape", async () => {
	const root = await tempStore();
	try {
		const first = appendInjectionRecord({
			memoryDir: root,
			session: "session-1",
			ts: "2026-08-13T17:00:00.000Z",
			blocks: [
				{
					kind: "context",
					content: "## Her CONTEXT.md\n\nFei values exact verification.\n",
					sources: ["narrative/CONTEXT.md", "narrative/FACTS.md"],
				},
			],
		});
		assert.equal(first.ts, "2026-08-13T17:00:00.000Z");
		assert.equal(first.session, "session-1");
		assert.equal(first.blocks.length, 1);
		assert.equal(first.blocks[0]?.kind, "context");
		assert.deepEqual(first.blocks[0]?.sources, ["narrative/CONTEXT.md", "narrative/FACTS.md"]);
		assert.match(first.blocks[0]?.digest ?? "", /^[0-9a-f]{16}$/);
		assert.equal(
			first.blocks[0]?.bytes,
			Buffer.byteLength("## Her CONTEXT.md\n\nFei values exact verification.\n", "utf8"),
		);

		appendInjectionRecord({
			memoryDir: root,
			session: "session-1",
			blocks: [{ kind: "recall", content: "No Her memory hits." }],
		});

		const raw = await readFile(injectionLedgerPath(root), "utf8");
		const lines = raw.split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		const parsed = lines.map((line) => JSON.parse(line) as { session?: string; blocks: unknown[] });
		assert.equal(parsed[0]?.session, "session-1");
		assert.equal(parsed[1]?.blocks.length, 1);
		assert.equal(raw.endsWith("\n"), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("appendInjectionRecord redacts absolute drive paths and keeps her-memory-relative paths", async () => {
	const root = await tempStore();
	try {
		appendInjectionRecord({
			memoryDir: root,
			session: "session-pii",
			blocks: [
				{
					kind: "recall",
					content: "fenced recall",
					sources: [
						"her-memory/world/article.md",
						"narrative/CONTEXT.md",
						"D:\\@Her\\her-memory\\world\\article.md",
						"C:\\Users\\Admin\\secret\\notes.md",
						"/home/fei/.env",
					],
				},
			],
		});
		const raw = await readFile(injectionLedgerPath(root), "utf8");
		assert.doesNotMatch(raw, /C:\\Users\\Admin/);
		assert.doesNotMatch(raw, /\/home\/fei/);
		const entry = JSON.parse(raw) as { blocks: Array<{ sources: string[] }> };
		assert.deepEqual(entry.blocks[0]?.sources, [
			"her-memory/world/article.md",
			"narrative/CONTEXT.md",
			"her-memory/world/article.md",
			"<redacted-abs>",
			"<redacted-abs>",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("applyBlockDedupe: flag off is passthrough", () => {
	const content = "full her-context";
	const digest = contentDigest(content);
	const first = applyBlockDedupe({
		enabled: false,
		kind: "context",
		content,
		digest,
		previousDigest: undefined,
	});
	const repeat = applyBlockDedupe({
		enabled: false,
		kind: "context",
		content,
		digest,
		previousDigest: digest,
	});
	assert.equal(first.text, content);
	assert.equal(first.unchanged, false);
	assert.equal(repeat.text, content);
	assert.equal(repeat.unchanged, false);
	assert.equal(isInjectDedupeEnabled({}), false);
	assert.equal(isInjectDedupeEnabled({ HER_INJECT_DEDUPE: "1" }), true);
	assert.equal(isInjectDedupeEnabled({ HER_INJECT_DEDUPE: "0" }), false);
});

test("applyBlockDedupe: first passes, repeat replaced, changed digest passes", () => {
	const content = "full her-context";
	const digest = contentDigest(content);
	const first = applyBlockDedupe({
		enabled: true,
		kind: "context",
		content,
		digest,
		previousDigest: undefined,
	});
	assert.equal(first.text, content);
	assert.equal(first.unchanged, false);

	const repeat = applyBlockDedupe({
		enabled: true,
		kind: "context",
		content,
		digest,
		previousDigest: digest,
	});
	assert.equal(repeat.text, unchangedInjectionMarker("context", digest));
	assert.match(repeat.text, /\[her-context unchanged: context digest [0-9a-f]{16}\]/);
	assert.equal(repeat.unchanged, true);

	const changed = applyBlockDedupe({
		enabled: true,
		kind: "context",
		content: "updated her-context",
		digest: contentDigest("updated her-context"),
		previousDigest: digest,
	});
	assert.equal(changed.text, "updated her-context");
	assert.equal(changed.unchanged, false);
});

test("injectLoggedContent: default flag is passthrough; ledger still appends", async () => {
	const root = await tempStore();
	const previous = process.env.HER_INJECT_DEDUPE;
	delete process.env.HER_INJECT_DEDUPE;
	resetInjectionDedupeState();
	try {
		const first = injectLoggedContent({
			memoryDir: root,
			session: "session-1",
			kind: "context",
			content: "full block",
			sources: ["narrative/CONTEXT.md"],
		});
		const second = injectLoggedContent({
			memoryDir: root,
			session: "session-1",
			kind: "context",
			content: "full block",
			sources: ["narrative/CONTEXT.md"],
		});
		assert.equal(first, "full block");
		assert.equal(second, "full block");
		const lines = (await readFile(injectionLedgerPath(root), "utf8")).split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
	} finally {
		if (previous === undefined) delete process.env.HER_INJECT_DEDUPE;
		else process.env.HER_INJECT_DEDUPE = previous;
		resetInjectionDedupeState();
		await rm(root, { recursive: true, force: true });
	}
});

test("injectLoggedContent: HER_INJECT_DEDUPE=1 replaces repeats per session and kind", async () => {
	const root = await tempStore();
	const previous = process.env.HER_INJECT_DEDUPE;
	process.env.HER_INJECT_DEDUPE = "1";
	resetInjectionDedupeState();
	try {
		const digest = contentDigest("full block");
		assert.equal(
			injectLoggedContent({ memoryDir: root, session: "s1", kind: "context", content: "full block" }),
			"full block",
		);
		assert.equal(
			injectLoggedContent({ memoryDir: root, session: "s1", kind: "context", content: "full block" }),
			unchangedInjectionMarker("context", digest),
		);
		assert.equal(
			injectLoggedContent({ memoryDir: root, session: "s1", kind: "recall", content: "full block" }),
			"full block",
			"other kinds do not share the previous digest",
		);
		assert.equal(
			injectLoggedContent({ memoryDir: root, session: "s2", kind: "context", content: "full block" }),
			"full block",
			"a new session always passes through first",
		);
		assert.equal(
			injectLoggedContent({ memoryDir: root, session: "s1", kind: "context", content: "changed block" }),
			"changed block",
		);
		const entries = (await readFile(injectionLedgerPath(root), "utf8"))
			.trim()
			.split("\n")
			.map(
				(line) => JSON.parse(line) as { blocks: Array<{ bytes: number; emittedBytes: number; emission: string }> },
			);
		assert.equal(entries[1]?.blocks[0]?.emission, "unchanged-marker");
		assert.equal(
			entries[1]?.blocks[0]?.emittedBytes,
			Buffer.byteLength(unchangedInjectionMarker("context", digest), "utf8"),
		);
	} finally {
		if (previous === undefined) delete process.env.HER_INJECT_DEDUPE;
		else process.env.HER_INJECT_DEDUPE = previous;
		resetInjectionDedupeState();
		await rm(root, { recursive: true, force: true });
	}
});

test("injectLoggedContent warns and still returns content when the ledger cannot append", async () => {
	const root = await tempStore();
	try {
		await writeFile(join(root, "audit"), "not-a-directory");
		const text = injectLoggedContent({
			memoryDir: root,
			session: "session-1",
			kind: "mirror",
			content: "A memory surfaced",
		});
		assert.equal(text, "A memory surfaced");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("context manifest records only hashes and selection metadata", async () => {
	const root = await tempStore();
	try {
		const manifest = buildContextManifest({
			task: "private user prompt",
			priorId: "abc123",
			mode: "shadow",
			promptChanged: false,
			budget: { limitTokens: 8192, availableTokens: 4, selectedTokens: 4, omittedBlocks: 0 },
			actual: [{ kind: "context", content: "private memory", sources: ["narrative/CONTEXT.md"] }],
			turn: [],
			proposed: [
				{
					layer: "L2",
					source: "narrative/CONTEXT.md",
					digest: contentDigest("private memory"),
					availableTokens: 4,
					selectedTokens: 4,
					privacy: "private",
					decision: "full",
					reason: "within-budget",
				},
			],
		});
		appendContextManifestRecord({ memoryDir: root, session: "s1", manifest });
		const raw = await readFile(injectionLedgerPath(root), "utf8");
		assert.doesNotMatch(raw, /private user prompt|private memory/);
		const record = JSON.parse(raw) as { manifest: typeof manifest };
		assert.equal(record.manifest.mode, "shadow");
		assert.equal(record.manifest.promptChanged, false);
		assert.match(record.manifest.taskDigest, /^[a-f0-9]{16}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selectTurnContext preserves current bytes when the turn fits", () => {
	const blocks = [
		{ kind: "context", content: "context" },
		{ kind: "wake", content: "wake" },
		{ kind: "inbox", content: "inbox" },
	];
	const selected = selectTurnContext({ mode: "enforce", budgetTokens: 100, blocks });

	assert.equal(selected.text, "context\n\nwake\n\ninbox");
	assert.equal(selected.promptChanged, false);
	assert.equal(selected.budget.omittedBlocks, 0);
	assert.ok(selected.decisions.every((decision) => decision.reason === "within-budget"));
});

test("selectTurnContext shadows and enforces inbox/wake before the narrative tail", () => {
	const first = "A".repeat(40);
	const tail = "B".repeat(40);
	const context = `${first}\n\n${tail}`;
	const blocks = [
		{ kind: "context", content: context, sources: ["narrative/CONTEXT.md", "narrative/SOUL.md"] },
		{ kind: "wake", content: "W".repeat(8), sources: ["tasks/wake"] },
		{ kind: "inbox", content: "I".repeat(8), sources: ["messages/inbox"] },
	];
	const narrativeSections = [
		{ source: "narrative/CONTEXT.md", content: first },
		{ source: "narrative/SOUL.md", content: tail },
	];
	const inboxFirst = selectTurnContext({ mode: "enforce", budgetTokens: 23, blocks, narrativeSections });
	const shadow = selectTurnContext({ mode: "shadow", budgetTokens: 10, blocks, narrativeSections });
	const enforced = selectTurnContext({ mode: "enforce", budgetTokens: 10, blocks, narrativeSections });

	assert.equal(inboxFirst.text, `${context}\n\n${"W".repeat(8)}`);
	assert.equal(inboxFirst.decisions.find((decision) => decision.kind === "wake")?.decision, "full");
	assert.equal(inboxFirst.decisions.find((decision) => decision.kind === "inbox")?.decision, "omitted");
	assert.equal(shadow.text, `${context}\n\n${"W".repeat(8)}\n\n${"I".repeat(8)}`);
	assert.equal(shadow.promptChanged, false);
	assert.equal(shadow.budget.selectedTokens, 10);
	assert.equal(enforced.text, first);
	assert.equal(enforced.promptChanged, true);
	assert.ok(estimateInjectionTokens(enforced.text) <= 10);
	assert.equal(enforced.decisions.find((decision) => decision.kind === "inbox")?.reason, "ephemeral-first");
	assert.equal(enforced.decisions.find((decision) => decision.kind === "wake")?.decision, "omitted");
	assert.equal(
		enforced.decisions.find((decision) => decision.source === "narrative/SOUL.md")?.reason,
		"narrative-tail",
	);
	assert.equal(enforced.budget.omittedBlocks, 3);
});
