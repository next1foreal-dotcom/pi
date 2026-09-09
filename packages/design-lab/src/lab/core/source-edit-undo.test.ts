// @vitest-environment jsdom

/**
 * Ctrl+Z over a source edit, through the same dispatcher as everything else.
 *
 * There is one stack and one shortcut, so the thing this file has to prove is
 * not that source edits can be undone — it is that they went onto the stack he
 * already has, in order, without changing what the other steps do. A second
 * stack with its own key would undo in an order that is not the order he
 * worked in, which is worse than no undo at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}
vi.stubGlobal("ResizeObserver", MockResizeObserver);

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

vi.mock("./lab-toasts", () => ({
	pushToast: vi.fn(),
	dismissToast: vi.fn(),
	useToasts: () => [],
}));

import type { HistoryCommand } from "./history";
import { applyHistory, type Session } from "./interaction-lab";
import { pushToast } from "./lab-toasts";

const noop = () => {};

/** Enough session for the branches under test; none of them read the canvas. */
function stubSession(): Session {
	const root = document.createElement("div");
	root.setAttribute("data-mode", "explore");
	const layer = document.createElement("div");
	root.appendChild(layer);
	document.body.appendChild(root);
	return {
		root,
		layer,
		grid: null,
		measure: null,
		snapX: document.createElement("div"),
		snapY: document.createElement("div"),
		ghost: null,
		chrome: new Map(),
		origin: { x: 0, y: 0 },
		viewport: { width: 1440, height: 900 },
		gesturing: false,
		idleTimer: 0,
		lastMove: 0,
		willChangeOn: false,
		dropWillChange: 0,
		canvasColor: "#f1f1f1",
		savedColors: [],
		mode: "explore",
		selectedId: null,
		focusedId: null,
		exploreCamera: null,
		layouts: { "screen-1": { x: 0, y: 0, width: 1440, height: 900 } },
		names: {},
		visible: {},
		lastPointer: { x: 720, y: 450 },
		drag: null,
		alt: false,
		measureHover: null,
		nudge: null,
		objects: new Map(),
		escapers: new Map(),
		bump: noop,
		getGuides: () => [],
		plugins: [],
		pluginApis: new Map(),
		pluginsOnCameraWrite: noop,
		disposeExtras: noop,
		getSnapshot: () => null as never,
	} as unknown as Session;
}

const edit: HistoryCommand = {
	type: "source-edit",
	endpoint: "classes",
	what: "拿掉 product-title",
	undo: {
		body: { file: "a.tsx", line: 116, column: 11, tag: "p", add: "product-title" },
		expect: "row-title",
	},
	redo: {
		body: { file: "a.tsx", line: 116, column: 11, tag: "p", remove: "product-title" },
		expect: "row-title product-title",
	},
};

describe("undoing a source edit", () => {
	let posted: { url: string; init: RequestInit }[];

	function serverSays(status: number, body: unknown): void {
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
		vi.mocked(pushToast).mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	it("sends the undo direction, with what it expects to find", async () => {
		serverSays(200, { ok: true, changed: true });
		await applyHistory(stubSession(), edit, true);

		expect(posted.length).toBe(1);
		expect(posted[0].url).toBe("/__lab-fs/element/classes");
		expect(JSON.parse(String(posted[0].init.body))).toEqual({
			file: "a.tsx",
			line: 116,
			column: 11,
			tag: "p",
			add: "product-title",
			expect: "row-title",
		});
		// Nothing to say: the module reloads and he sees it.
		expect(vi.mocked(pushToast)).not.toHaveBeenCalled();
	});

	it("sends the redo direction the other way", async () => {
		// The other half of the test above. A dispatcher that ignored `invert`
		// would pass it and then apply the same edit twice.
		serverSays(200, { ok: true, changed: true });
		await applyHistory(stubSession(), edit, false);

		expect(JSON.parse(String(posted[0].init.body))).toEqual({
			file: "a.tsx",
			line: 116,
			column: 11,
			tag: "p",
			remove: "product-title",
			expect: "row-title product-title",
		});
	});

	it("says the step was dropped, in the server's own words", async () => {
		// He edited that line himself since. The undo must not overwrite it, and
		// it must not disappear quietly either: the step is already off the undo
		// stack, so silence would read as "undo did nothing".
		const said =
			'refusing: expected className to be "row-title", found "row-title lead"';
		serverSays(409, { ok: false, problem: "stale-expect", error: said });
		await applyHistory(stubSession(), edit, true);

		expect(vi.mocked(pushToast)).toHaveBeenCalledTimes(1);
		const shown = vi.mocked(pushToast).mock.calls[0][0];
		expect(shown).toContain(said);
		expect(shown).toContain("拿掉 product-title");
		expect(shown).toContain("dropped");
	});

	it("says so too when the dev server is not there", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("dev server down"));
		await applyHistory(stubSession(), edit, true);
		expect(vi.mocked(pushToast)).toHaveBeenCalledTimes(1);
	});
});

describe("the steps that were already on the stack", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.innerHTML = "";
	});

	it("still moves a screen back, and asks the dev server nothing", async () => {
		// Source edits are a new branch in a dispatcher that already had six.
		// This is the guard that the new one did not take a gesture off one of
		// them: undoing a drag is local, and must stay local.
		const fetched = vi.spyOn(globalThis, "fetch");
		const s = stubSession();
		await applyHistory(
			s,
			{ type: "move", id: "screen-1", from: { x: 0, y: 0 }, to: { x: 400, y: 200 } },
			true,
		);
		expect(s.layouts["screen-1"]).toMatchObject({ x: 0, y: 0 });

		await applyHistory(
			s,
			{ type: "move", id: "screen-1", from: { x: 0, y: 0 }, to: { x: 400, y: 200 } },
			false,
		);
		expect(s.layouts["screen-1"]).toMatchObject({ x: 400, y: 200 });
		expect(fetched).not.toHaveBeenCalled();
	});

	it("still skips a step whose screen is gone", async () => {
		const s = stubSession();
		await applyHistory(
			s,
			{ type: "move", id: "not-here", from: { x: 0, y: 0 }, to: { x: 4, y: 4 } },
			true,
		);
		expect(vi.mocked(pushToast)).toHaveBeenCalledWith("skipped — gone");
	});
});
