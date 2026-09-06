import { describe, expect, it } from "vitest";
import { projectNoteFeed } from "./note-feed";

const AT = "2026-09-05T20:00:00.000Z";

function line(event: Record<string, unknown>): string {
	return `${JSON.stringify(event)}\n`;
}

describe("projectNoteFeed", () => {
	it("skips a torn line and keeps the records on either side", () => {
		const feed =
			line({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				text: "kept",
			}) +
			'{"t":"note","id":\n' +
			line({
				t: "reply",
				id: "r_bbbbbbbbbbbb",
				noteId: "n_aaaaaaaaaaaa",
				at: AT,
				author: "samantha",
				text: "24px now",
			});
		const threads = projectNoteFeed(feed);
		const note = threads.get("n_aaaaaaaaaaaa");
		expect(note).toBeDefined();
		expect(note?.replies.map((r) => r.text)).toEqual(["24px now"]);
	});

	it("merges replies onto the note they name, in order", () => {
		const feed =
			line({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				text: "too tight",
			}) +
			line({
				t: "reply",
				id: "r_111111111111",
				noteId: "n_aaaaaaaaaaaa",
				at: AT,
				author: "samantha",
				text: "24px now",
			}) +
			line({
				t: "reply",
				id: "r_222222222222",
				noteId: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				text: "better",
			});
		const threads = projectNoteFeed(feed);
		expect(
			threads.get("n_aaaaaaaaaaaa")?.replies.map((r) => [r.author, r.text]),
		).toEqual([
			["samantha", "24px now"],
			["fei", "better"],
		]);
		expect(threads.get("n_aaaaaaaaaaaa")?.resolved).toBe(false);
	});

	it("keeps last note.edit as the live text and last note.move as the live position", () => {
		const threads = projectNoteFeed(
			line({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "first words",
			}) +
				line({
					t: "note.edit",
					id: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
					text: "second words",
				}) +
				line({
					t: "note.move",
					id: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
					screenId: "mosaic",
					x: 90,
					y: 40,
				}),
		);
		const note = threads.get("n_aaaaaaaaaaaa");
		expect(note?.text).toBe("second words");
		expect(note?.x).toBe(90);
		expect(note?.y).toBe(40);
		expect(note?.screenId).toBe("mosaic");
	});

	it("lets resolve and reopen set the resolved flag, last write winning", () => {
		const base = line({
			t: "note",
			id: "n_aaaaaaaaaaaa",
			at: AT,
			author: "fei",
			text: "too tight",
		});
		const resolved = projectNoteFeed(
			base +
				line({
					t: "resolve",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "samantha",
				}),
		);
		expect(resolved.get("n_aaaaaaaaaaaa")?.resolved).toBe(true);

		const reopened = projectNoteFeed(
			base +
				line({
					t: "resolve",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "samantha",
				}) +
				line({
					t: "reopen",
					noteId: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
				}),
		);
		expect(reopened.get("n_aaaaaaaaaaaa")?.resolved).toBe(false);
	});

	it("projects an optional anchor on note and note.move", () => {
		const threads = projectNoteFeed(
			line({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "pin",
				anchor: { screenId: "playground", rx: 0.25, ry: 0.5 },
			}) +
				line({
					t: "note.move",
					id: "n_aaaaaaaaaaaa",
					at: AT,
					author: "fei",
					screenId: "mosaic",
					x: 90,
					y: 40,
					anchor: { screenId: "mosaic", rx: 0.1, ry: 0.2 },
				}),
		);
		const note = threads.get("n_aaaaaaaaaaaa");
		expect(note?.x).toBe(90);
		expect(note?.y).toBe(40);
		expect(note?.screenId).toBe("mosaic");
		expect(note?.anchor).toEqual({ screenId: "mosaic", rx: 0.1, ry: 0.2 });
	});

	it("still projects a legacy note that has no anchor", () => {
		const threads = projectNoteFeed(
			line({
				t: "note",
				id: "n_aaaaaaaaaaaa",
				at: AT,
				author: "fei",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "old pin",
			}),
		);
		const note = threads.get("n_aaaaaaaaaaaa");
		expect(note?.text).toBe("old pin");
		expect(note?.x).toBe(10);
		expect(note?.y).toBe(20);
		expect(note?.screenId).toBe("playground");
		expect(note?.anchor).toBeUndefined();
	});
});
