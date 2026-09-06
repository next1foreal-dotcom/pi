import { describe, expect, it } from "vitest";
import { projectNoteFeed } from "./note-feed";
import { threadRows, unresolvedCount } from "./open-threads";

const AT = "2026-09-05T20:00:00.000Z";

function line(event: Record<string, unknown>): string {
	return `${JSON.stringify(event)}\n`;
}

function note(
	id: string,
	text: string,
	screenId: string,
	xy: { x: number; y: number } = { x: 10, y: 20 },
): string {
	return line({
		t: "note",
		id,
		at: AT,
		author: "fei",
		screenId,
		x: xy.x,
		y: xy.y,
		text,
	});
}

describe("unresolvedCount reads G-429 thread state, not a second projection", () => {
	it("two unresolved notes → 2", () => {
		const live = projectNoteFeed(
			note("n_aaaaaaaaaaaa", "too tight", "playground") +
				note("n_bbbbbbbbbbbb", "need more space", "mosaic", {
					x: 400,
					y: 80,
				}),
		);
		expect(unresolvedCount(live.values())).toBe(2);
	});

	it("a samantha reply that is not resolved still counts", () => {
		const live = projectNoteFeed(
			note("n_aaaaaaaaaaaa", "too tight", "playground") +
				line({
					t: "reply",
					id: "r_cccccccccccc",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "samantha",
					text: "24px now",
				}),
		);
		expect(unresolvedCount(live.values())).toBe(1);
		expect(live.get("n_aaaaaaaaaaaa")?.resolved).toBe(false);
		expect(live.get("n_aaaaaaaaaaaa")?.replies).toHaveLength(1);
	});

	it("a resolved note does not count", () => {
		const live = projectNoteFeed(
			note("n_aaaaaaaaaaaa", "too tight", "playground") +
				note("n_bbbbbbbbbbbb", "done", "mosaic", { x: 400, y: 80 }) +
				line({
					t: "resolve",
					noteId: "n_bbbbbbbbbbbb",
					at: AT,
					author: "samantha",
				}),
		);
		expect(unresolvedCount(live.values())).toBe(1);
	});

	it("zero unresolved → 0 (the HUD must not paint this as a digit)", () => {
		const empty = projectNoteFeed("");
		expect(unresolvedCount(empty.values())).toBe(0);

		const allResolved = projectNoteFeed(
			note("n_aaaaaaaaaaaa", "too tight", "playground") +
				line({
					t: "resolve",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
				}),
		);
		expect(unresolvedCount(allResolved.values())).toBe(0);
	});

	it("a reply with no note body is not an open thread", () => {
		const live = projectNoteFeed(
			line({
				t: "reply",
				id: "r_cccccccccccc",
				noteId: "n_aaaaaaaaaaaa",
				at: AT,
				author: "samantha",
				text: "orphan",
			}),
		);
		expect(unresolvedCount(live.values())).toBe(0);
	});
});

describe("threadRows", () => {
	const feed =
		note("n_aaaaaaaaaaaa", "too tight", "playground") +
		note("n_bbbbbbbbbbbb", "shipped", "mosaic", { x: 400, y: 80 }) +
		line({
			t: "reply",
			id: "r_cccccccccccc",
			noteId: "n_aaaaaaaaaaaa",
			at: AT,
			author: "samantha",
			text: "24px now",
		}) +
		line({
			t: "reply",
			id: "r_dddddddddddd",
			noteId: "n_aaaaaaaaaaaa",
			at: AT,
			author: "fei",
			text: "ok",
		}) +
		line({
			t: "resolve",
			noteId: "n_bbbbbbbbbbbb",
			at: AT,
			author: "samantha",
		});

	it("hides resolved notes by default", () => {
		const rows = threadRows(projectNoteFeed(feed));
		expect(rows.map((r) => r.id)).toEqual(["n_aaaaaaaaaaaa"]);
		expect(rows[0]?.hasReply).toBe(true);
		expect(rows[0]?.screenId).toBe("playground");
		expect(rows[0]?.text).toBe("too tight");
	});

	it("can include resolved notes when asked", () => {
		const rows = threadRows(projectNoteFeed(feed), true);
		expect(rows.map((r) => r.id)).toEqual([
			"n_aaaaaaaaaaaa",
			"n_bbbbbbbbbbbb",
		]);
		expect(rows[1]?.resolved).toBe(true);
		expect(rows[1]?.hasReply).toBe(false);
	});

	it("does not treat Fei's own reply as her reply", () => {
		const live = projectNoteFeed(
			note("n_aaaaaaaaaaaa", "too tight", "playground") +
				line({
					t: "reply",
					id: "r_eeeeeeeeeeee",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
					text: "nudge",
				}),
		);
		expect(threadRows(live)[0]?.hasReply).toBe(false);
	});
});
