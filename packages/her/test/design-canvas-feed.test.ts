import assert from "node:assert/strict";
import test from "node:test";

import {
	type CanvasEvent,
	CURSOR_START,
	cursorOf,
	parseFeed,
	projectThreads,
	readSince,
	serializeEvent,
} from "../src/design-canvas/feed.ts";

/**
 * The feed is the channel Fei points down and she listens on. Its whole job is
 * to answer "what has been said that I have not read yet" — so the cursor is
 * the part that has to be right. tracepaper (MIT, caffeinum/tracepaper @74d2756)
 * learned this the hard way and wrote it down: a cursor must NOT be a comment
 * id, because an id gets re-resolved through that row's live state, so
 * resolving or editing the comment a cursor names drags the boundary past
 * everything written in between and loses it for good.
 *
 * We take the same lesson by a cheaper route: the log is append-only and a
 * record's position IS its sequence. Nothing stores a number that two writers
 * could pick at the same time, and no event ever moves.
 */

const AT = "2026-09-05T20:00:00.000Z";

function note(id: string, text: string, extra: Partial<CanvasEvent> = {}): CanvasEvent {
	return {
		t: "note",
		id,
		at: AT,
		author: "fei",
		screenId: "product-list",
		x: 100,
		y: 200,
		text,
		...extra,
	} as CanvasEvent;
}

function feedOf(events: CanvasEvent[]): string {
	return events.map(serializeEvent).join("");
}

test("a cursor is a position in the log, not the name of a record", () => {
	const events = [note("n1", "too tight"), note("n2", "wrong green"), note("n3", "fix the gap")];
	const feed = feedOf(events);

	const first = readSince(feed, CURSOR_START);
	assert.equal(first.events.length, 3);
	assert.equal(first.cursor, cursorOf(3));

	// Nothing new since: an empty page echoes the incoming cursor back rather
	// than resetting the reader to the start of the feed.
	const second = readSince(feed, first.cursor);
	assert.deepEqual(second.events, []);
	assert.equal(second.cursor, first.cursor);
});

test("resolving the record a cursor names does not drag the boundary", () => {
	// The exact failure tracepaper documents. Read up to n1, then n2 and n3
	// arrive, then n1 — the one the cursor is sitting on — gets resolved.
	const feed = feedOf([
		note("n1", "too tight"),
		note("n2", "wrong green"),
		note("n3", "fix the gap"),
		{ t: "resolve", noteId: "n1", at: AT, author: "samantha", note: "done" },
	]);

	const afterFirst = cursorOf(1);
	const next = readSince(feed, afterFirst);

	// n2 and n3 must still be there. If the cursor resolved through n1's live
	// state they would be gone, silently and permanently.
	const ids = next.events.map((e) => ("id" in e ? e.id : "noteId" in e ? e.noteId : ""));
	assert.deepEqual(ids, ["n2", "n3", "n1"]);
	assert.equal(next.cursor, cursorOf(4));
});

test("a deleted note's events stay in the log, so a cursor outlives it", () => {
	const feed = feedOf([
		note("n1", "too tight"),
		{ t: "note.delete", id: "n1", at: AT, author: "fei" },
		note("n2", "wrong green"),
	]);

	// The cursor sitting on the deleted note still advances correctly.
	const next = readSince(feed, cursorOf(1));
	assert.equal(next.events.length, 2);
	assert.equal(next.cursor, cursorOf(3));

	// But the projection drops it: it is gone from the canvas.
	const threads = projectThreads(parseFeed(feed));
	assert.deepEqual(
		threads.map((t) => t.id),
		["n2"],
	);
});

test("a thread carries its replies and who said what", () => {
	const feed = feedOf([
		note("n1", "this gap is too tight"),
		{ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" },
		{ t: "reply", id: "r2", noteId: "n1", at: AT, author: "fei", text: "better" },
	]);

	const [thread] = projectThreads(parseFeed(feed));
	assert.equal(thread.text, "this gap is too tight");
	assert.equal(thread.author, "fei");
	assert.equal(thread.screenId, "product-list");
	assert.deepEqual(
		thread.replies.map((r) => [r.author, r.text]),
		[
			["samantha", "24px now"],
			["fei", "better"],
		],
	);
	assert.equal(thread.resolved, false);
});

test("resolve and reopen are both just events, and the last one wins", () => {
	const base = [note("n1", "too tight")];
	const resolved = projectThreads(
		parseFeed(feedOf([...base, { t: "resolve", noteId: "n1", at: AT, author: "samantha" }])),
	);
	assert.equal(resolved[0].resolved, true);
	assert.equal(resolved[0].resolvedBy, "samantha");

	const reopened = projectThreads(
		parseFeed(
			feedOf([
				...base,
				{ t: "resolve", noteId: "n1", at: AT, author: "samantha" },
				{ t: "reopen", noteId: "n1", at: AT, author: "fei" },
			]),
		),
	);
	assert.equal(reopened[0].resolved, false);
});

/**
 * The source travels on the wire and is declared on the event, and until now the
 * projection dropped it on the floor — so the one thing that would let her go
 * straight to the code he pointed at never survived the trip into a Thread.
 */
test("where he pinned the note survives into the thread she reads", () => {
	const feed = feedOf([
		note("n1", "this gap is too tight", {
			source: {
				file: "packages/design-lab/src/screens/playground/screen.tsx",
				line: 19,
				col: 25,
				component: "PlaygroundScreen",
			},
		}),
		note("n2", "wrong green"),
	]);

	const [pinned, loose] = projectThreads(parseFeed(feed));
	assert.deepEqual(pinned.source, {
		file: "packages/design-lab/src/screens/playground/screen.tsx",
		line: 19,
		col: 25,
		component: "PlaygroundScreen",
	});
	// A note pinned on empty canvas carries nothing, and must not invent it.
	assert.equal(loose.source, undefined);
});

test("dragging the pin does not rewrite what he was talking about", () => {
	// The move carries the original source forward on the wire, and a later
	// version of the canvas could carry a different one. Neither may reach the
	// thread: a drag is not him saying he meant a different button — the same
	// reason a move is not a speaking event and gets no oid.
	const pinned = {
		file: "packages/design-lab/src/screens/playground/screen.tsx",
		line: 19,
		col: 25,
		component: "PlaygroundScreen",
	};
	const feed = feedOf([
		note("n1", "too tight", { source: pinned }),
		{
			t: "note.move",
			id: "n1",
			at: AT,
			author: "fei",
			screenId: "mosaic",
			x: 900,
			y: 40,
			source: {
				file: "packages/design-lab/src/screens/mosaic/screen.tsx",
				line: 4,
				col: 2,
				component: "MosaicScreen",
			},
		},
	]);

	const [thread] = projectThreads(parseFeed(feed));
	assert.deepEqual(thread.source, pinned);
	// The move still does what a move is for.
	assert.deepEqual([thread.screenId, thread.x, thread.y], ["mosaic", 900, 40]);
});

test("a move rewrites position and screen, an edit rewrites text", () => {
	const feed = feedOf([
		note("n1", "first words"),
		{ t: "note.edit", id: "n1", at: AT, author: "fei", text: "second words" },
		{ t: "note.move", id: "n1", at: AT, author: "fei", screenId: "mosaic", x: 900, y: 40 },
	]);
	const [thread] = projectThreads(parseFeed(feed));
	assert.equal(thread.text, "second words");
	assert.equal(thread.screenId, "mosaic");
	assert.deepEqual([thread.x, thread.y], [900, 40]);
});

test("one malformed line does not take the feed down with it", () => {
	// Half a line can exist: the browser and her runtime both append, and a
	// crash mid-write leaves a partial record. Losing that one line is fine.
	// Losing the feed is not.
	const feed = `${serializeEvent(note("n1", "kept"))}{"t":"note","id":\n${serializeEvent(note("n2", "also kept"))}`;
	const events = parseFeed(feed);
	assert.deepEqual(
		events.map((e) => ("id" in e ? e.id : "")),
		["n1", "n2"],
	);
});

test("an unknown cursor reads from the start rather than throwing", () => {
	const feed = feedOf([note("n1", "a")]);
	for (const bad of ["", "garbage", "cur_-1", "cur_x"]) {
		const r = readSince(feed, bad);
		assert.equal(r.events.length, 1, `cursor ${JSON.stringify(bad)} should read from the start`);
	}
	// But a cursor past the end is not an error either — it just has nothing.
	assert.deepEqual(readSince(feed, cursorOf(99)).events, []);
});

test("serializeEvent writes exactly one line, newline-terminated", () => {
	const line = serializeEvent(note("n1", "has\nnewlines\tand tabs"));
	assert.equal(line.endsWith("\n"), true);
	assert.equal(line.slice(0, -1).includes("\n"), false);
	assert.equal(JSON.parse(line).text, "has\nnewlines\tand tabs");
});
