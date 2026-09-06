import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { CanvasEvent, NoteSource } from "../src/design-canvas/feed.ts";
import { appendEvent } from "../src/design-canvas/store.ts";
import { registerDesignCanvasTools } from "../src/design-canvas/tools.ts";

/**
 * What `design_lab_notes` actually puts in front of her.
 *
 * He points at a button and writes "this gap is too tight". The canvas has known
 * which file and line made that button since the source started travelling on
 * the note event — but the tool she reads dropped it, so what reached her was
 * words plus a screen name and a pair of page coordinates. She had to guess
 * which element of that screen he meant, or spend a reply asking him.
 *
 * These tests read the rendered text rather than a projection, because the text
 * is the whole deliverable: a field that is present in memory and absent from
 * what she reads is exactly the bug this package exists to fix.
 */

const AT = "2026-09-06T04:00:00.000Z";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "her-canvas-tools-"));
}

function fromFei(id: string, text: string, extra: Partial<CanvasEvent> = {}): CanvasEvent {
	return {
		t: "note",
		id,
		at: AT,
		author: "fei",
		screenId: "product-list",
		x: 10,
		y: 20,
		text,
		...extra,
	} as CanvasEvent;
}

const PLAYGROUND_BUTTON: NoteSource = {
	file: "packages/design-lab/src/screens/playground/screen.tsx",
	line: 19,
	col: 25,
	component: "PlaygroundScreen",
};

interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/** The real registration, against a temp repo root, with pi faked down to registerTool. */
function notesTool(root: string): ToolDefinition {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignCanvasTools(pi, { repoRoot: root });
	const tool = tools.get("design_lab_notes");
	assert.ok(tool, "design_lab_notes should be registered");
	return tool;
}

async function readNotes(root: string): Promise<string> {
	const result = (await notesTool(root).execute("call-1", {}, undefined, undefined, undefined as never)) as ToolResult;
	return result.content.map((part) => part.text).join("\n");
}

/** The head line of one thread, which is where she looks first. */
function headOf(text: string, id: string): string | undefined {
	return text.split("\n").find((row) => row.startsWith(`${id} `));
}

test("a note arrives already naming the file and line he pinned it on", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "this gap is too tight", { source: PLAYGROUND_BUTTON }), root);

		assert.equal(
			headOf(await readNotes(root), "n1"),
			"n1 on product-list at packages/design-lab/src/screens/playground/screen.tsx:19 (PlaygroundScreen) — this gap is too tight",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a note with no location reads exactly as it did before locations existed", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight"), root);
		appendEvent(fromFei("n2", "wrong green", { screenId: null }), root);

		const text = await readNotes(root);
		// No brackets, no "unknown", no trailing "at" — the sentence she already knows.
		assert.equal(headOf(text, "n1"), "n1 on product-list — too tight");
		assert.equal(headOf(text, "n2"), "n2 on the canvas — wrong green");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a location whose component could not be named gets no empty parenthesis", async () => {
	const root = tempRoot();
	try {
		appendEvent(
			fromFei("n1", "this is off", {
				screenId: null,
				source: {
					file: "packages/design-lab/src/screens/mosaic/screen.tsx",
					line: 7,
					col: 2,
					component: null,
				},
			}),
			root,
		);

		assert.equal(
			headOf(await readNotes(root), "n1"),
			"n1 on the canvas at packages/design-lab/src/screens/mosaic/screen.tsx:7 — this is off",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the location rides on a still-open thread too, not only a fresh one", async () => {
	// Two calls: the second reports n1 under "Still open from before", built by
	// the same renderer. A location that only survived the fresh path would leave
	// her blind on exactly the notes she has been sitting on longest.
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "this gap is too tight", { source: PLAYGROUND_BUTTON }), root);

		const first = await readNotes(root);
		assert.match(first, /New since you last looked/);

		const second = await readNotes(root);
		assert.match(second, /Still open from before/);
		assert.equal(
			headOf(second, "n1"),
			"n1 on product-list at packages/design-lab/src/screens/playground/screen.tsx:19 (PlaygroundScreen) — this gap is too tight",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("replies still hang under the note, under its location", async () => {
	const root = tempRoot();
	try {
		appendEvent(fromFei("n1", "too tight", { source: PLAYGROUND_BUTTON }), root);
		appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);

		const text = await readNotes(root);
		const rows = text.split("\n");
		const head = rows.findIndex((row) => row.startsWith("n1 "));
		assert.ok(head >= 0, "the thread should be rendered");
		assert.match(rows[head] ?? "", /at packages\/design-lab\/src\/screens\/playground\/screen\.tsx:19/);
		assert.equal(rows[head + 1], "    samantha: 24px now");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
