import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CanvasEvent } from "../src/design-canvas/feed.ts";
import { appendEvent, feedPath, readCanvas, readCursor } from "../src/design-canvas/store.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "her-canvas-"));
}

const AT = "2026-09-05T20:00:00.000Z";

function fromFei(id: string, text: string, screenId: string | null = "product-list"): CanvasEvent {
	return { t: "note", id, at: AT, author: "fei", screenId, x: 10, y: 20, text };
}

test("a note he writes reaches her, and the cursor advances past it", () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "this gap is too tight"), root);

		const first = readCanvas({ repoRoot: root });
		assert.equal(first.fresh.length, 1);
		assert.equal(first.fresh[0].text, "this gap is too tight");
		assert.equal(first.fresh[0].author, "fei");

		// She has now seen it: a second look has nothing new.
		const second = readCanvas({ repoRoot: root });
		assert.equal(second.fresh.length, 0);
		assert.equal(readCursor(root), first.cursor);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unanswered note stays in `open` forever, however many times she looks", () => {
	// The backstop. Advancing the cursor on read is only safe because of this:
	// a page lost to a crash, a wiped cursor file or two reads racing would
	// otherwise mean a note he wrote, she never saw, and he assumed she read.
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "wrong green"), root);
		readCanvas({ repoRoot: root });
		readCanvas({ repoRoot: root });
		const third = readCanvas({ repoRoot: root });

		assert.equal(third.fresh.length, 0, "nothing new");
		assert.equal(third.open.length, 1, "but still open");
		assert.equal(third.open[0].id, "n1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolving is what takes it out of `open` — reading never does", () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "wrong green"), root);
		readCanvas({ repoRoot: root });
		assert.equal(readCanvas({ repoRoot: root }).open.length, 1);

		appendEvent({ t: "resolve", noteId: "n1", at: AT, author: "samantha" }, root);
		assert.equal(readCanvas({ repoRoot: root }).open.length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("she can look at one screen without losing sight of the rest", () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight", "product-list"), root);
		appendEvent(fromFei("n2", "wrong green", "mosaic"), root);

		const scoped = readCanvas({ repoRoot: root, screenId: "mosaic", advance: false });
		assert.deepEqual(
			scoped.open.map((t) => t.id),
			["n2"],
		);

		const whole = readCanvas({ repoRoot: root, advance: false });
		assert.deepEqual(
			whole.open.map((t) => t.id),
			["n1", "n2"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two writers appending at once both survive", () => {
	// The browser and her runtime both append to this file. Nothing in a record
	// says where it sits, so there is no number for them to collide on.
	const root = tempRoot();
	try {
		for (let i = 0; i < 40; i++) {
			appendEvent(fromFei(`n${i}`, `note ${i}`), root);
			appendEvent({ t: "reply", id: `r${i}`, noteId: `n${i}`, at: AT, author: "samantha", text: "ok" }, root);
		}
		const lines = readFileSync(feedPath(root), "utf8").trim().split("\n");
		assert.equal(lines.length, 80);
		const reading = readCanvas({ repoRoot: root, advance: false });
		assert.equal(reading.open.length, 40);
		assert.equal(reading.open[0].replies.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("her own words are not news to her", () => {
	// Found by walking the real loop rather than by a unit test: replying and
	// resolving append events, which advanced the feed, so the next read
	// announced her own reply back to her as "new since you last looked" — and
	// kept nagging about a thread she had just closed. "New" has to mean new
	// TO HER, which is about who wrote it, not about the cursor moving.
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		readCanvas({ repoRoot: root });

		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		appendEvent({ t: "resolve", noteId: "n1", at: AT, author: "samantha" }, root);

		const after = readCanvas({ repoRoot: root });
		assert.equal(after.fresh.length, 0, "her own reply and resolve are not new feedback");
		assert.equal(after.open.length, 0, "and the thread she resolved is closed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("but a new word from him after she replied IS news again", () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		readCanvas({ repoRoot: root });
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
		readCanvas({ repoRoot: root });

		appendEvent({ t: "reply", id: "r2", noteId: "n1", at: AT, author: "fei", text: "still too tight" }, root);
		const after = readCanvas({ repoRoot: root });
		assert.deepEqual(
			after.fresh.map((t) => t.id),
			["n1"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
