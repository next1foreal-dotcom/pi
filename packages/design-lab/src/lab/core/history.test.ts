// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectFor,
	peekUndo,
	popRedo,
	popUndo,
	pushHistory,
	sendSourceEdit,
	type HistoryCommand,
	type SourceEditDirection,
} from "./history";

/**
 * A source edit is a step on the same stack as everything else he does.
 *
 * The two halves that can go wrong are here: the command has to survive
 * `sessionStorage` (it is stored as JSON, so anything that is not plain data
 * comes back as something else, and the undo silently sends the wrong body),
 * and the request has to carry the `expect` that makes an undo refuse rather
 * than overwrite whatever is there now.
 */

const undoDir: SourceEditDirection = {
	body: {
		file: "packages/design-lab/src/screens/product-list/components/Browse.tsx",
		line: 116,
		column: 11,
		tag: "p",
		add: "product-title",
	},
	expect: "row-title",
};

const redoDir: SourceEditDirection = {
	body: {
		file: "packages/design-lab/src/screens/product-list/components/Browse.tsx",
		line: 116,
		column: 11,
		tag: "p",
		remove: "product-title",
	},
	expect: "row-title product-title",
};

function command(): HistoryCommand {
	return {
		type: "source-edit",
		endpoint: "classes",
		what: "拿掉 product-title",
		undo: undoDir,
		redo: redoDir,
	};
}

describe("a source edit on the undo stack", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("comes back out of sessionStorage byte for byte", () => {
		// It is stored as JSON. A command carrying anything that does not
		// survive `JSON.stringify` would come back missing the field the undo
		// needs, and the undo would post a body that means something else.
		pushHistory(command());
		expect(peekUndo()).toEqual(command());
	});

	it("keeps the two directions apart", () => {
		// The one bug this shape exists to prevent is undoing with the redo
		// body: the edit would be applied twice and read as "undo did nothing".
		pushHistory(command());
		const back = popUndo();
		expect(back?.type).toBe("source-edit");
		if (back?.type !== "source-edit") throw new Error("wrong command type");
		expect(back.undo.body.add).toBe("product-title");
		expect(back.undo.body.remove).toBeUndefined();
		expect(back.redo.body.remove).toBe("product-title");
		expect(back.redo.body.add).toBeUndefined();
		expect(back.undo.expect).toBe("row-title");
		expect(back.redo.expect).toBe("row-title product-title");
	});

	it("goes back onto the undo stack when it is redone", () => {
		pushHistory(command());
		popUndo();
		expect(popRedo()).toEqual(command());
		expect(peekUndo()).toEqual(command());
	});
});

describe("what an undo expects to find", () => {
	it("passes a real value through unchanged", () => {
		expect(expectFor("row-title product-title")).toBe("row-title product-title");
		expect(expectFor('tone="loud"')).toBe('tone="loud"');
	});

	it("says null when there was nothing there", () => {
		// The endpoints answer "" for an attribute that is not on the tag. Null
		// is how the wire says "expect it to be absent"; leaving it as "" would
		// be indistinguishable from an attribute whose value is empty.
		expect(expectFor("")).toBeNull();
	});
});

describe("sending one direction of a source edit", () => {
	let posted: { url: string; init: RequestInit }[] = [];

	function reply(status: number, body: unknown): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(((url: string, init: RequestInit) => {
			posted.push({ url, init });
			return Promise.resolve({
				ok: status >= 200 && status < 300,
				status,
				json: () => Promise.resolve(body),
			});
		}) as unknown as typeof fetch);
	}

	beforeEach(() => {
		posted = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts the body with its expect, to the endpoint the command names", async () => {
		reply(200, { ok: true, changed: true });
		const out = await sendSourceEdit("classes", undoDir);

		expect(out).toEqual({ ok: true });
		expect(posted.length).toBe(1);
		expect(posted[0].url).toBe("/__lab-fs/element/classes");
		// Same guard the panels carry. Without it the server answers 403 and the
		// undo would report "forbidden" for every step.
		expect((posted[0].init.headers as Record<string, string>)["x-lab-canvas"]).toBe("1");
		expect(JSON.parse(String(posted[0].init.body))).toEqual({
			file: "packages/design-lab/src/screens/product-list/components/Browse.tsx",
			line: 116,
			column: 11,
			tag: "p",
			add: "product-title",
			expect: "row-title",
		});
	});

	it("addresses the other two endpoints by name", async () => {
		reply(200, { ok: true, changed: true });
		await sendSourceEdit("text", { body: { file: "a.tsx" }, expect: "old" });
		await sendSourceEdit("prop", { body: { file: "a.tsx" }, expect: null });
		expect(posted.map((p) => p.url)).toEqual([
			"/__lab-fs/element/text",
			"/__lab-fs/element/prop",
		]);
		// Null is a value on the wire, not an omission: omitting it would turn
		// the compare-and-swap off and let the undo overwrite a changed file.
		expect(JSON.parse(String(posted[1].init.body))).toEqual({ file: "a.tsx", expect: null });
	});

	it("hands back the server's own sentence when it refuses", async () => {
		const said =
			'refusing to undo: expected className to be "row-title product-title", found "row-title lead"';
		reply(409, { ok: false, problem: "stale-expect", error: said });
		const out = await sendSourceEdit("classes", undoDir);

		expect(out.ok).toBe(false);
		// Verbatim. It knows what it expected and what it found; a friendlier
		// paraphrase here is worth less than the sentence it replaces.
		expect(out.ok === false && out.note).toBe(said);
	});

	it("still says something when the refusal carries no sentence", async () => {
		reply(500, {});
		const out = await sendSourceEdit("text", { body: {}, expect: null });
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.note).toContain("500");
	});

	it("does not report success when the dev server is gone", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("dev server down"));
		const out = await sendSourceEdit("prop", { body: {}, expect: null });
		expect(out.ok).toBe(false);
		expect(out.ok === false && out.note).toContain("dev server down");
	});

	it("does not report success on a 200 that is not ok", async () => {
		// The endpoints answer 200 with `ok:false` for nothing at all, but a
		// body-shaped answer that never said ok must not be read as a write.
		reply(200, { changed: true });
		const out = await sendSourceEdit("classes", undoDir);
		expect(out.ok).toBe(false);
	});
});
