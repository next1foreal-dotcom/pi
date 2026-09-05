import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CanvasEvent } from "../src/design-canvas/feed.ts";
import {
	acceptProposal,
	declineProposal,
	pendingForHer,
	pendingProposals,
	withCanvasNag,
} from "../src/design-canvas/nag.ts";
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

function plantProposal(
	root: string,
	partial: {
		id: string;
		screenId?: string | null;
		items?: { his: string; hers: string }[];
		at?: string;
		from?: string[];
		status?: string;
	},
): void {
	const dir = join(root, "design", "canvas");
	mkdirSync(dir, { recursive: true });
	appendFileSync(
		join(dir, "rule-proposals.jsonl"),
		`${JSON.stringify({
			at: AT,
			screenId: "product-list",
			items: SAMPLE_ITEMS,
			from: ["d1", "d2", "d3"],
			status: "pending",
			...partial,
		})}\n`,
		"utf8",
	);
}

function proposalFile(root: string): string {
	return join(root, "design", "canvas", "rule-proposals.jsonl");
}

function proposalLines(root: string): string[] {
	const file = proposalFile(root);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function relativeFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(relative(root, full).split("\\").join("/"));
		}
	};
	walk(root);
	return out.sort();
}

function plantSkillFiles(root: string): { skill: string; nested: string; body: string } {
	const body = "taste rule: never auto-write here\n";
	const skill = join(root, "SKILL.md");
	const nestedDir = join(root, ".claude", "skills", "taste");
	mkdirSync(nestedDir, { recursive: true });
	const nested = join(nestedDir, "SKILL.md");
	writeFileSync(skill, body, "utf8");
	writeFileSync(nested, body, "utf8");
	return { skill, nested, body };
}

const SAMPLE_ITEMS = [
	{ his: "too tight", hers: "24px" },
	{ his: "wrong green", hers: "hue shifted" },
	{ his: "fix the gap", hers: "closed it" },
];

function expectedProposalNag(items: { his: string; hers: string }[], screenId: string): string {
	return [
		`他在 ${screenId} 上提过 ${items.length} 次同一带的意见,你都改了:`,
		...items.map((item) => `  他:${item.his}  →  你:${item.hers}`),
		"看看这几条背后是不是同一条口味。是的话,下次跟他聊的时候用你自己的话说出来,让他确认。",
		"别自己当规矩用,也别写进任何 skill 文件——没经他点头的口味不算数。",
	].join("\n");
}

test("a pending proposal hitchhikes as its own text part, next to the todo nag", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		plantProposal(root, { id: "p_old", items: SAMPLE_ITEMS, from: ["d1", "d2", "d3"] });

		const result = await runDummy(root, () => originalResult());
		assert.equal(result.content.length, 3, "original + todo nag + proposal nag, not mashed together");
		assert.equal(result.content[0].text, "photo ok");
		assert.match(result.content[1].text, /没处理的意见/);
		assert.match(result.content[1].text, /n1 on product-list: too tight/);
		assert.equal(result.content[2].text, expectedProposalNag(SAMPLE_ITEMS, "product-list"));
		assert.equal(pendingProposals(root).length, 1, "showing it must not mark it handled");
		assert.equal(proposalLines(root).length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("zero proposals add nothing — even when a todo nag is present", async () => {
	const root = tempRoot();
	try {
		const quiet = await runDummy(root, () => originalResult());
		assert.deepEqual(quiet, originalResult());
		assert.equal(pendingProposals(root).length, 0);

		appendEvent(fromFei("n1", "too tight"), root);
		const withTodo = await runDummy(root, () => originalResult());
		assert.equal(withTodo.content.length, 2);
		assert.equal(withTodo.content[0].text, "photo ok");
		assert.match(withTodo.content[1].text, /没处理的意见/);
		assert.doesNotMatch(withTodo.content[1].text, /同一带的意见/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("three pending proposals: only the oldest one is raised", async () => {
	const root = tempRoot();
	try {
		plantProposal(root, {
			id: "p_a",
			at: "2026-09-01T00:00:00.000Z",
			screenId: "mosaic",
			items: [{ his: "first gripe", hers: "first fix" }],
			from: ["a1", "a2", "a3"],
		});
		plantProposal(root, {
			id: "p_b",
			at: "2026-09-02T00:00:00.000Z",
			screenId: "mosaic",
			items: [{ his: "second gripe", hers: "second fix" }],
			from: ["b1", "b2", "b3"],
		});
		plantProposal(root, {
			id: "p_c",
			at: "2026-09-03T00:00:00.000Z",
			screenId: "mosaic",
			items: [{ his: "third gripe", hers: "third fix" }],
			from: ["c1", "c2", "c3"],
		});

		assert.deepEqual(
			pendingProposals(root).map((p) => p.id),
			["p_a", "p_b", "p_c"],
			"oldest first",
		);

		const result = await runDummy(root, () => originalResult());
		assert.equal(result.content.length, 2, "one extra text, not three");
		assert.equal(result.content[1].text, expectedProposalNag([{ his: "first gripe", hers: "first fix" }], "mosaic"));
		assert.doesNotMatch(result.content[1].text, /second gripe/);
		assert.doesNotMatch(result.content[1].text, /third gripe/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("acceptProposal appends a new line; the original pending row is still there", () => {
	const root = tempRoot();
	try {
		plantProposal(root, { id: "p_old", items: SAMPLE_ITEMS });
		const before = proposalLines(root);
		assert.equal(before.length, 1);
		assert.equal(pendingProposals(root).length, 1);

		acceptProposal("p_old", root);

		const after = proposalLines(root);
		assert.equal(after.length, 2, "status change is a new record, not a rewrite");
		assert.equal(after[0], before[0]);
		const added = JSON.parse(after[1] as string) as { id: string; status: string };
		assert.equal(added.id, "p_old");
		assert.equal(added.status, "accepted");
		assert.equal(pendingProposals(root).length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("declineProposal appends declined and drops it from pendingProposals", () => {
	const root = tempRoot();
	try {
		plantProposal(root, { id: "p_no", items: SAMPLE_ITEMS });
		declineProposal("p_no", root);
		assert.equal(proposalLines(root).length, 2);
		assert.equal(pendingProposals(root).length, 0);
		const added = JSON.parse(proposalLines(root)[1] as string) as { status: string };
		assert.equal(added.status, "declined");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing or torn proposals file does not break the wrapped tool", async () => {
	const root = tempRoot();
	try {
		const missing = await runDummy(root, () => originalResult());
		assert.deepEqual(missing, originalResult());
		assert.deepEqual(pendingProposals(root), []);

		const dir = join(root, "design", "canvas");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			proposalFile(root),
			`{"not":"valid"\n${JSON.stringify({
				id: "p_kept",
				at: AT,
				items: SAMPLE_ITEMS,
				from: ["d1", "d2", "d3"],
				status: "pending",
			})}\n`,
			"utf8",
		);
		assert.deepEqual(
			pendingProposals(root).map((p) => p.id),
			["p_kept"],
		);
		const torn = await runDummy(root, () => originalResult());
		assert.equal(torn.content.length, 2);
		assert.equal(torn.content[0].text, "photo ok");
		assert.match(torn.content[1].text, /同一带的意见/);

		rmSync(proposalFile(root), { force: true });
		mkdirSync(proposalFile(root), { recursive: true });
		const unreadable = await runDummy(root, () => originalResult());
		assert.deepEqual(unreadable, originalResult());
		assert.deepEqual(pendingProposals(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("raising or deciding a proposal never writes a skill file", async () => {
	const root = tempRoot();
	try {
		const planted = plantSkillFiles(root);
		plantProposal(root, { id: "p_old", items: SAMPLE_ITEMS });
		const before = relativeFiles(root).filter((p) => /skill/i.test(p));

		await runDummy(root, () => originalResult());
		acceptProposal("p_old", root);
		plantProposal(root, { id: "p_next", screenId: "mosaic", items: [{ his: "too loud", hers: "quieted it" }] });
		declineProposal("p_next", root);

		assert.equal(readFileSync(planted.skill, "utf8"), planted.body);
		assert.equal(readFileSync(planted.nested, "utf8"), planted.body);
		assert.deepEqual(
			relativeFiles(root).filter((p) => /skill/i.test(p)),
			before,
		);
		assert.equal(existsSync(join(root, "Agents.md")), false);
		assert.ok(
			relativeFiles(root).every((p) => !p.split("/").includes("skills") || p.startsWith(".claude/skills/")),
			"no new skills path appeared",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
