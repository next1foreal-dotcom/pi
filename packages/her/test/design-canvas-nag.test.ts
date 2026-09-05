import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CanvasEvent } from "../src/design-canvas/feed.ts";
import { pendingForHer, withCanvasNag } from "../src/design-canvas/nag.ts";
import { appendEvent, readCanvas, readCursor } from "../src/design-canvas/store.ts";

const AT = "2026-09-05T20:00:00.000Z";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "her-canvas-nag-"));
}

function fromFei(id: string, text: string, screenId: string | null = "product-list"): CanvasEvent {
	return { t: "note", id, at: AT, author: "fei", screenId, x: 10, y: 20, text };
}

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
}

function fakePi(): { pi: ExtensionAPI; tools: Map<string, ToolDefinition> } {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

function originalResult(overrides: Partial<ToolResult> = {}): ToolResult {
	return {
		content: [{ type: "text", text: "photo ok" }],
		details: { ok: true, paths: ["a.png"] },
		...overrides,
	};
}

async function runDummy(root: string, execute: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
	const { pi, tools } = fakePi();
	const wrapped = withCanvasNag(pi, root);
	wrapped.registerTool({
		name: "dummy",
		label: "Dummy",
		description: "test",
		parameters: {},
		async execute() {
			return await execute();
		},
	} as unknown as ToolDefinition);
	const tool = tools.get("dummy");
	assert.ok(tool);
	return (await tool.execute("call-1", {}, undefined, undefined, undefined as never)) as ToolResult;
}

function nagText(result: ToolResult): string | undefined {
	const last = result.content[result.content.length - 1];
	return last?.type === "text" ? last.text : undefined;
}

test("unanswered note is appended; her reply clears it; a read does not", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);

		const first = await runDummy(root, () => originalResult());
		assert.equal(first.content.length, 2, "unanswered note appends one text part");
		assert.equal(first.content[0].text, "photo ok");
		assert.equal(
			nagText(first),
			[
				"他在画布上还有 1 条没处理的意见:",
				"- n1 on product-list: too tight",
				"先处理这些,再继续你原来的计划。回复用 design_lab_reply,真改完了用 design_lab_resolve。",
			].join("\n"),
		);

		readCanvas({ repoRoot: root });
		const afterRead = await runDummy(root, () => originalResult());
		assert.equal(afterRead.content.length, 2, "reading the feed must not clear the nag");
		assert.match(nagText(afterRead) ?? "", /n1 on product-list: too tight/);

		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		const afterReply = await runDummy(root, () => originalResult());
		assert.equal(afterReply.content.length, 1, "her reply is the action that clears it");
		assert.equal(afterReply.content[0].text, "photo ok");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("zero pending leaves the original result untouched", async () => {
	const root = tempRoot();
	try {
		const result = await runDummy(root, () => originalResult());
		assert.deepEqual(result, originalResult());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("original details and isError survive the nag", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "wrong green"), root);
		const result = await runDummy(root, () =>
			originalResult({
				details: { ok: false, reason: "blurry" },
				isError: true,
			}),
		);
		assert.equal(result.isError, true);
		assert.deepEqual(result.details, { ok: false, reason: "blurry" });
		assert.equal(result.content[0].text, "photo ok");
		assert.equal(result.content.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a throwing execute still throws; the wrapper does not swallow it", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		const { pi, tools } = fakePi();
		withCanvasNag(pi, root).registerTool({
			name: "dummy",
			label: "Dummy",
			description: "test",
			parameters: {},
			async execute() {
				throw new Error("camera down");
			},
		} as unknown as ToolDefinition);
		const tool = tools.get("dummy");
		assert.ok(tool);
		await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, undefined as never), {
			message: "camera down",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing feed file does not break the wrapped tool", async () => {
	const root = tempRoot();
	try {
		const result = await runDummy(root, () => originalResult());
		assert.deepEqual(result, originalResult());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable feed is swallowed; the original result comes back", async () => {
	const root = tempRoot();
	try {
		const feed = join(root, "design", "canvas", "feed.jsonl");
		mkdirSync(feed, { recursive: true });
		const result = await runDummy(root, () => originalResult());
		assert.deepEqual(result, originalResult());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hitchhiking does not advance her read cursor", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		const before = readCursor(root);
		await runDummy(root, () => originalResult());
		assert.equal(readCursor(root), before);
		const reading = readCanvas({ repoRoot: root, advance: false });
		assert.equal(reading.fresh.length, 1, "the note is still unread");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("pendingForHer is unresolved threads she has not spoken on", () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		appendEvent(fromFei("n2", "wrong green"), root);
		appendEvent({ t: "reply", id: "r1", noteId: "n2", at: AT, author: "samantha", text: "ok" }, root);
		appendEvent(fromFei("n3", "fix the gap"), root);
		appendEvent({ t: "resolve", noteId: "n3", at: AT, author: "samantha" }, root);

		const pending = pendingForHer(root);
		assert.deepEqual(
			pending.map((t) => t.id),
			["n1"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a torn line in the feed does not take the nag down", async () => {
	const root = tempRoot();
	try {
		const dir = join(root, "design", "canvas");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "feed.jsonl"),
			`${JSON.stringify(fromFei("n1", "kept"))}\n{"t":"note","id":\n${JSON.stringify(fromFei("n2", "also kept"))}\n`,
			"utf8",
		);
		const pending = pendingForHer(root);
		assert.deepEqual(
			pending.map((t) => t.id),
			["n1", "n2"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("when he speaks last, it nags again — a reply of hers is not a mute button", () => {
	// The gap the executor flagged rather than quietly papering over. The
	// criterion was "unresolved AND she has not replied", so once she answered
	// once, nothing he said afterwards could reach her this way: reopening a
	// thread, or objecting again under it, was silent.
	//
	// The criterion that actually holds is "the last word is his". A thread
	// she answered goes quiet; the moment he says anything else on it, it
	// comes back.
	const root = tempRoot();
	try {
		const note = (id: string, text: string): CanvasEvent => ({
			t: "note",
			id,
			at: AT,
			author: "fei",
			screenId: "s",
			x: 0,
			y: 0,
			text,
		});
		appendEvent(note("n1", "too tight"), root);
		appendEvent(note("n2", "wrong green"), root);
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		// she answered n1, so only n2 is waiting on her
		assert.deepEqual(
			pendingForHer(root).map((t) => t.id),
			["n2"],
		);

		// he comes back on n1 — this must reach her
		appendEvent({ t: "reply", id: "r2", noteId: "n1", at: AT, author: "fei", text: "still too tight" }, root);
		assert.deepEqual(
			pendingForHer(root).map((t) => t.id),
			["n1", "n2"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a reopened thread nags again too", () => {
	const root = tempRoot();
	try {
		appendEvent({ t: "note", id: "n1", at: AT, author: "fei", screenId: "s", x: 0, y: 0, text: "too tight" }, root);
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "done" }, root);
		appendEvent({ t: "resolve", noteId: "n1", at: AT, author: "samantha" }, root);
		assert.deepEqual(pendingForHer(root), [], "resolved and answered: quiet");

		appendEvent({ t: "reopen", noteId: "n1", at: AT, author: "fei" }, root);
		assert.deepEqual(
			pendingForHer(root).map((t) => t.id),
			["n1"],
			"he reopened it — that is him speaking last",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("but dragging the note is not speaking — a move does not wake it up", () => {
	// The other side of "last word". He rearranges his canvas all the time;
	// moving a sticky he already got an answer on must not ask her again.
	const root = tempRoot();
	try {
		appendEvent({ t: "note", id: "n1", at: AT, author: "fei", screenId: "s", x: 0, y: 0, text: "too tight" }, root);
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		assert.deepEqual(pendingForHer(root), [], "answered: quiet");

		appendEvent({ t: "note.move", id: "n1", at: AT, author: "fei", screenId: "s", x: 900, y: 40 }, root);
		assert.deepEqual(pendingForHer(root), [], "he only moved it — still quiet");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rewording his own note counts as speaking", () => {
	// The doc comment on Thread.lastSpoke has always said editing the words
	// counts. The code did not, and no test asked — so he could rewrite an
	// objection she had already answered and she would never hear the new
	// wording.
	const root = tempRoot();
	try {
		appendEvent({ t: "note", id: "n1", at: AT, author: "fei", screenId: "s", x: 0, y: 0, text: "too tight" }, root);
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		assert.deepEqual(pendingForHer(root), [], "answered: quiet");

		appendEvent({ t: "note.edit", id: "n1", at: AT, author: "fei", text: "still too tight, try 32" }, root);
		assert.deepEqual(
			pendingForHer(root).map((t) => t.id),
			["n1"],
			"he rewrote it — that is him speaking",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
