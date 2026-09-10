// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkApiDocs } from "../../plugin-api";
import { labelOf, LayersPanel, listChildren, plugin, screenRoots } from "./plugin";

let host: HTMLElement;
let panel: LayersPanel | null = null;
let selected: Element | null = null;
let hovered: Element | null | undefined;
let selectCalls: Element[] = [];

/**
 * The slice of lab DOM this plugin reads: screens, each with the frame's own
 * content wrapper, and one piece of lab chrome parked inside a screen the way
 * the notes host really is.
 */
function buildLab(screens: string[] = ["playground", "product-list"]): void {
	document.body.innerHTML = "";
	const root = document.createElement("div");
	root.setAttribute("data-mode", "explore");
	for (const id of screens) {
		const group = document.createElement("div");
		group.setAttribute("data-screen-id", id);
		const scroll = document.createElement("div");
		scroll.setAttribute("data-screen-scroll", id);
		const content = document.createElement("div");
		content.setAttribute("data-screen-content", "");
		const page = document.createElement("div");
		page.className = `${id}-root page`;
		const heading = document.createElement("h1");
		heading.className = "title";
		const para = document.createElement("p");
		const link = document.createElement("a");
		para.appendChild(link);
		page.append(heading, para);
		content.appendChild(page);
		scroll.appendChild(content);
		group.appendChild(scroll);
		root.appendChild(group);
	}
	host = document.createElement("div");
	host.dataset.plugin = "layers";
	root.appendChild(host);
	document.body.appendChild(root);
}

/** Only the three calls the panel makes. Stubbing the door is the whole seam. */
function stubInspect(): void {
	(window as unknown as { lab: unknown }).lab = {
		plugin: (id: string) =>
			id === "inspect"
				? {
						selectElement: (el: Element) => {
							selectCalls.push(el);
							selected = el;
							return null;
						},
						selectedElement: () => selected,
						hoverElement: (el: Element | null) => {
							hovered = el;
							return el !== null;
						},
					}
				: undefined,
		plugins: () => ["inspect"],
		describe: () => [],
		help: () => ({}),
		tokens: { preview: () => {} },
		canvas: {
			screens: () => [],
			lockInto: () => false,
			exit: () => {},
			state: () => ({ mode: "explore", focusedId: null }),
		},
	};
}

function rows(): HTMLElement[] {
	return Array.from(host.querySelectorAll<HTMLElement>(".ly-row"));
}

function labels(): string[] {
	return rows().map((r) => r.querySelector(".ly-name")?.textContent ?? "");
}

function rowFor(label: string): HTMLElement {
	const found = rows().find(
		(r) => r.querySelector(".ly-name")?.textContent === label,
	);
	if (!found) throw new Error(`no row "${label}" in [${labels().join(", ")}]`);
	return found;
}

function twistOf(label: string): HTMLElement {
	return rowFor(label).querySelector(".ly-twist") as HTMLElement;
}

function enter(row: HTMLElement): void {
	row.dispatchEvent(new MouseEvent("pointerenter", { bubbles: false }));
}

beforeEach(() => {
	selected = null;
	hovered = undefined;
	selectCalls = [];
	buildLab();
	stubInspect();
	try {
		localStorage.clear();
	} catch {
		// jsdom always has one; this is only for the environments that do not.
	}
});

afterEach(() => {
	panel?.destroy();
	panel = null;
	(window as unknown as { lab?: unknown }).lab = undefined;
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("what the tree shows", () => {
	it("lists the screens, and walks nothing until one is opened", () => {
		panel = new LayersPanel(host);
		expect(labels()).toEqual(["playground", "product-list"]);
		// The cost claim, stated as a test: a closed screen is one row, not a
		// row per node in the page it is holding.
		expect(panel.state().rows).toBe(2);
	});

	it("opens a screen onto its own first element, not the lab's wrapper", () => {
		// `screen-frame` wraps every screen in a sized `[data-screen-content]`
		// div that is the lab's, not the design's. Rooting at the scroller put
		// one row of plumbing at the top of every screen, and everyone then had
		// to click through it to reach the first thing they drew.
		panel = new LayersPanel(host);
		rowFor("playground").click();
		expect(labels()).toEqual([
			"playground",
			"div.playground-root",
			"product-list",
		]);
	});

	it("goes one level at a time", () => {
		// The twist, not the row: a click on a row is a selection. Only screen
		// rows open on a plain click, because a screen is not selectable.
		panel = new LayersPanel(host);
		rowFor("playground").click();
		twistOf("div.playground-root").click();
		expect(labels()).toEqual([
			"playground",
			"div.playground-root",
			"h1.title",
			"p",
			"product-list",
		]);
		expect(labels()).not.toContain("a");
	});

	it("never lists the lab's own chrome", () => {
		// A row that pointed at a sticky-note host would offer to select
		// something the canvas refuses to select. Same list the hit test uses.
		const scroll = document.querySelector("[data-screen-scroll]") as HTMLElement;
		const content = scroll.querySelector("[data-screen-content]") as HTMLElement;
		const notes = document.createElement("div");
		notes.setAttribute("data-notes-host", "");
		const inside = document.createElement("div");
		inside.className = "sn-note";
		notes.appendChild(inside);
		content.appendChild(notes);

		panel = new LayersPanel(host);
		rowFor("playground").click();
		expect(labels()).toEqual([
			"playground",
			"div.playground-root",
			"product-list",
		]);
	});

	it("says how many children a branch is hiding", () => {
		panel = new LayersPanel(host);
		rowFor("playground").click();
		const row = rowFor("div.playground-root");
		expect(row.querySelector(".ly-of")?.textContent).toBe("2");
	});
});

describe("the tree and the canvas point at each other", () => {
	it("a row lights its element on the canvas, and lets go on the way out", () => {
		panel = new LayersPanel(host);
		rowFor("playground").click();
		const row = rowFor("div.playground-root");

		enter(row);
		expect(hovered).toBe(document.querySelector(".playground-root"));
		row.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
		expect(hovered).toBeNull();
	});

	it("clicking a row selects that node, and marks the row", () => {
		panel = new LayersPanel(host);
		rowFor("playground").click();
		rowFor("div.playground-root").click();

		expect(selectCalls).toEqual([document.querySelector(".playground-root")]);
		expect(rowFor("div.playground-root").hasAttribute("data-on")).toBe(true);
		expect(panel.state().selected).toBe("div.playground-root");
	});

	it("a screen row opens and closes and selects nothing", () => {
		// A screen row addresses the scroller, and the canvas refuses to select
		// a scroller — it is the frame, not anything in the design.
		panel = new LayersPanel(host);
		rowFor("playground").click();
		expect(selectCalls).toEqual([]);
		rowFor("playground").click();
		expect(labels()).toEqual(["playground", "product-list"]);
		expect(selectCalls).toEqual([]);
	});

	it("opening a branch is not selecting it", () => {
		// The twist is about the tree; the row is about the element. Letting the
		// twist through would select something every time you looked inside.
		panel = new LayersPanel(host);
		rowFor("playground").click();
		twistOf("div.playground-root").click();
		expect(labels()).toContain("h1.title");
		expect(selectCalls).toEqual([]);
	});

	it("reveal opens every ancestor and puts the row on screen", () => {
		panel = new LayersPanel(host);
		const link = document.querySelector("a") as HTMLElement;

		expect(panel.reveal(link)).toBe(true);
		expect(labels()).toEqual([
			"playground",
			"div.playground-root",
			"h1.title",
			"p",
			"a",
			"product-list",
		]);
	});

	it("takes down the last reveal's scaffolding before putting up its own", async () => {
		// Without this the tree only grows. Every canvas click opens a whole
		// ancestor chain and nothing ever closes; measured on the real canvas,
		// 29 rows of which about twenty were a log list left open from an
		// earlier selection that had nothing to do with the one on screen.
		panel = new LayersPanel(host);
		const link = document.querySelector("a") as HTMLElement;
		const heading = document.querySelector("h1") as HTMLElement;

		panel.reveal(link);
		expect(labels()).toContain("a");
		panel.reveal(heading);

		// The heading's own path is open; the link's branch is not still open
		// underneath it.
		expect(labels()).toContain("h1.title");
		expect(labels()).not.toContain("a");
	});

	it("but never takes down a branch someone opened by hand", async () => {
		// Opening a branch is a decision. A reveal is scaffolding for one
		// selection; it has no business undoing the other kind.
		//
		// Asserted on the branch's CONTENTS, not on its row: a row survives
		// either way, because its parent gets reopened on the new path. The
		// first version of this test checked the row and passed with the rule
		// inverted — a green that meant nothing.
		panel = new LayersPanel(host);
		rowFor("playground").click();
		twistOf("div.playground-root").click();
		twistOf("p").click();
		expect(labels()).toContain("a");

		panel.reveal(document.querySelector("h1") as HTMLElement);
		expect(labels()).toContain("h1.title");
		expect(labels(), "the hand-opened paragraph is still open").toContain("a");
	});

	it("and a hand on a branch a reveal opened makes it a decision", async () => {
		panel = new LayersPanel(host);
		const link = document.querySelector("a") as HTMLElement;
		panel.reveal(link);
		// Close and reopen the paragraph by hand: now it is his, not the
		// reveal's, and the next reveal leaves it alone.
		twistOf("p").click();
		twistOf("p").click();

		panel.reveal(document.querySelector("h1") as HTMLElement);
		expect(labels()).toContain("a");
	});

	it("and says no to a node that is not on a screen", () => {
		panel = new LayersPanel(host);
		const loose = document.createElement("div");
		document.body.appendChild(loose);
		expect(panel.reveal(loose)).toBe(false);
	});

	it("selecting on the canvas opens the tree to it", async () => {
		// The half that makes it a pair rather than two lists. A press is the
		// only thing the panel can see, so it is what it listens for.
		panel = new LayersPanel(host);
		selected = document.querySelector("a");

		window.dispatchEvent(new Event("pointerup"));
		await new Promise((r) => setTimeout(r, 0));
		expect(labels()).toContain("a");
		expect(rowFor("a").hasAttribute("data-on")).toBe(true);
	});

	it("but does not re-open branches you closed, when the row is already there", async () => {
		panel = new LayersPanel(host);
		rowFor("playground").click();
		selected = document.querySelector(".playground-root");

		window.dispatchEvent(new Event("pointerup"));
		await new Promise((r) => setTimeout(r, 0));
		expect(labels()).toEqual([
			"playground",
			"div.playground-root",
			"product-list",
		]);
	});
});

describe("the panel itself", () => {
	it("claims its own press, or none of its rows would answer", () => {
		// The lesson the element toolbar paid for: a press the canvas does not
		// recognise starts a pan, preventDefaults the pointerdown and takes a
		// pointer capture — and the click never happens.
		panel = new LayersPanel(host);
		expect(
			host.querySelector(".ly-panel")?.hasAttribute("data-lab-chrome"),
		).toBe(true);
	});

	it("folds away and remembers it", () => {
		panel = new LayersPanel(host);
		expect(panel.state().folded).toBe(false);
		panel.setFolded(true);
		expect(host.querySelector(".ly-panel")?.hasAttribute("data-folded")).toBe(
			true,
		);

		panel.destroy();
		panel = new LayersPanel(host);
		expect(panel.state().folded).toBe(true);
	});

	it("opens anyway when storage refuses to answer", () => {
		// A private window, blocked site data, a preview that throws on access.
		// It is a fold state; it is not worth a broken panel.
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		panel = new LayersPanel(host);
		expect(panel.state().folded).toBe(false);
		expect(labels()).toEqual(["playground", "product-list"]);
	});

	it("says so when the canvas has no screens", () => {
		buildLab([]);
		panel = new LayersPanel(host);
		expect(rows()).toEqual([]);
		expect(host.querySelector(".ly-empty")?.textContent).toContain("屏幕");
	});

	it("takes its panel and its listener with it", () => {
		panel = new LayersPanel(host);
		panel.destroy();
		expect(host.querySelector(".ly-panel")).toBeNull();
		// A destroyed panel that still answered pointerup would keep a whole
		// dead tree alive across a StrictMode remount.
		window.dispatchEvent(new Event("pointerup"));
		expect(host.querySelector(".ly-row")).toBeNull();
		panel = null;
	});
});

describe("a design's versions, in the panel", () => {
	// The tools her side got (`design_version_history` / `design_version_restore`)
	// answer the same two questions from the same code. This is the half Fei can
	// reach without asking her, which for "put yesterday's back" is the half that
	// matters.

	const V1 = "a".repeat(40);
	const V2 = "b".repeat(40);
	const VERSIONS = [
		{
			commit: V2,
			at: "2026-09-09T12:00:00Z",
			subject: "feat: second pass",
			name: null,
			files: ["packages/design-lab/src/screens/playground/screen.tsx"],
		},
		{
			commit: V1,
			at: "2026-09-08T09:00:00Z",
			subject: "feat: first pass",
			name: "the one with the wide hero",
			files: ["packages/design-lab/src/screens/playground/screen.tsx"],
		},
	];

	let sent: { url: string; init?: RequestInit }[] = [];

	/** Answers the two endpoints, and remembers exactly what was asked. */
	function stubFetch(
		over: { versions?: unknown; restore?: unknown; project?: unknown; fail?: boolean } = {},
	): void {
		sent = [];
		(globalThis as { fetch: unknown }).fetch = (url: string, init?: RequestInit) => {
			sent.push({ url, ...(init ? { init } : {}) });
			if (over.fail) return Promise.reject(new Error("no dev server"));
			// A screen with no workshop answers 204, which is most of them.
			//
			// Modelled the way a real 204 behaves: no body, so `.json()` REJECTS.
			// The first version of this stub resolved an empty object instead,
			// and the status guard it was meant to be testing turned out to be
			// untested — inverting the guard kept every test green.
			if (url.startsWith("/__lab-fs/project?")) {
				return Promise.resolve({
					status: over.project ? 200 : 204,
					json: () =>
						over.project
							? Promise.resolve(over.project)
							: Promise.reject(new SyntaxError("Unexpected end of JSON input")),
				} as Response);
			}
			const body = url.startsWith("/__lab-fs/versions?")
				? (over.versions ?? { ok: true, versions: VERSIONS, dirty: ["screen.tsx"] })
				: (over.restore ?? {
						ok: true,
						commit: V1,
						files: ["a.tsx", "b.tsx"],
						applied: false,
						dirty: ["a.tsx"],
					});
			return Promise.resolve({ status: 200, json: () => Promise.resolve(body) } as Response);
		};
	}

	function versionRows(): HTMLElement[] {
		return Array.from(host.querySelectorAll<HTMLElement>(".ly-ver"));
	}

	afterEach(() => {
		(globalThis as { fetch?: unknown }).fetch = undefined;
	});

	it("swaps the tree for the history, newest first", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(panel.state().history).toBe("playground");
		expect(panel.state().versions).toBe(2);
		expect(versionRows().length).toBe(2);
		expect(host.querySelector(".ly-back")?.textContent).toContain("playground");
		// The tree is gone while the history is up — one panel, two things to say.
		expect(host.querySelectorAll(".ly-row").length).toBe(0);
		expect(sent.map((x) => x.url)).toContain("/__lab-fs/versions?slug=playground");
	});

	it("shows the workshop ledger above the versions", async () => {
		// `design_project_*` has kept this since G-375 and none of it was ever
		// visible from the canvas. Fei asked twice.
		stubFetch({
			project: {
				ok: true,
				stages: ["idea", "wireframe", "draft", "final"],
				manifest: {
					brief: "a landing page",
					stage: "draft",
					gates: {
						wireframe: { status: "approved", at: "x", evidence: "Fei said so" },
						final: { status: "pending", at: "x" },
					},
					iterations: [{ summary: "one", at: "x" }, { summary: "two", at: "x" }],
				},
			},
		});
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(panel.state().project).toEqual({ stage: "draft", rounds: 2 });
		const text = host.querySelector(".ly-list")?.textContent ?? "";
		expect(text).toContain("draft");
		expect(text).toContain("3 / 4");
		expect(text).toContain("2 轮");
		// A verdict someone gave reads louder than the ledger waiting.
		const approved = host.querySelector(".ly-gate[data-ok]");
		expect(approved?.textContent).toContain("线框");
		expect(approved?.getAttribute("title")).toBe("Fei said so");
		expect(host.querySelector(".ly-gate[data-back]")).toBeNull();
	});

	it("and says nothing at all for a screen with no workshop", async () => {
		// Most screens have none. A 204 is not an error and not an empty
		// section — it is a screen somebody drew without opening a workshop.
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(panel.state().project).toBeNull();
		expect(host.querySelector(".ly-gate")).toBeNull();
		expect(host.querySelector(".ly-list")?.textContent ?? "").not.toContain("PROJECT");
		// The versions are still there — one read failing must not lose the other.
		expect(versionRows().length).toBe(2);
	});

	it("a name someone chose wins the line over a commit subject", async () => {
		// Naming is how a person marks the handful worth coming back to, and it
		// says more than "feat: first pass" ever will.
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(versionRows()[1]?.textContent).toContain("the one with the wide hero");
		expect(versionRows()[1]?.textContent).not.toContain("first pass");
		expect(versionRows()[0]?.textContent).toContain("second pass");
	});

	it("clicking a version asks what it would change, and writes nothing", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		versionRows()[1]?.click();
		await new Promise((r) => setTimeout(r, 0));
		const post = sent.find((s) => s.url === "/__lab-fs/versions/restore");
		expect(JSON.parse(String(post?.init?.body))).toEqual({
			slug: "playground",
			commit: V1,
			apply: false,
		});
		expect(host.querySelector(".ly-plan")?.textContent).toContain("2");
	});

	it("and says what it would cost before it offers the button", async () => {
		// Uncommitted work is the only part of this git cannot give back. It is
		// named above the button, not in a message after it.
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");
		versionRows()[1]?.click();
		await new Promise((r) => setTimeout(r, 0));

		const cost = host.querySelector(".ly-cost");
		const go = host.querySelector(".ly-go");
		expect(cost?.textContent).toContain("1");
		expect(go).not.toBeNull();
		expect(cost?.compareDocumentPosition(go as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("the second click is the one that writes, and it carries the guard", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");
		versionRows()[1]?.click();
		await new Promise((r) => setTimeout(r, 0));

		(host.querySelector(".ly-go") as HTMLElement).click();
		await new Promise((r) => setTimeout(r, 0));
		const writes = sent.filter(
			(x) => x.url === "/__lab-fs/versions/restore" && JSON.parse(String(x.init?.body)).apply === true,
		);
		expect(writes.length).toBe(1);
		const headers = writes[0]?.init?.headers as Record<string, string>;
		expect(headers["x-lab-canvas"]).toBe("1");
	});

	it("offers nothing to restore when the version is already what is on disk", async () => {
		stubFetch({ restore: { ok: true, commit: V1, files: [], applied: false, dirty: [] } });
		panel = new LayersPanel(host);
		await panel.openHistory("playground");
		versionRows()[1]?.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(host.querySelector(".ly-plan")?.textContent).toContain("一模一样");
		expect(host.querySelector(".ly-go")).toBeNull();
	});

	it("says it could not read them, rather than showing a design with no past", async () => {
		// An empty list and an unreachable dev server look identical, and only
		// one of them means "this design has never been committed".
		stubFetch({ fail: true });
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(panel.state().note).toContain("读不到版本");
		expect(versionRows().length).toBe(0);
	});

	it("says so plainly when a design has never been committed", async () => {
		stubFetch({ versions: { ok: true, versions: [], dirty: [] } });
		panel = new LayersPanel(host);
		await panel.openHistory("playground");

		expect(panel.state().note).toContain("还没有提交过");
	});

	it("comes back to the tree, with the branches it had open", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		rowFor("playground").click();
		await panel.openHistory("playground");
		panel.closeHistory();

		expect(panel.state().history).toBeNull();
		expect(labels()).toContain("div.playground-root");
	});

	it("a press on the canvas does not reach into the tree behind it", async () => {
		// The panel re-reads the tree after every press, and opens it to
		// whatever was just selected. Doing that while the history is up would
		// rearrange the tree behind your back — you would come out of the
		// version list into branches you never opened.
		stubFetch();
		panel = new LayersPanel(host);
		await panel.openHistory("playground");
		const openBefore = panel.state().open;
		selected = document.querySelector("a");

		window.dispatchEvent(new Event("pointerup"));
		await new Promise((r) => setTimeout(r, 0));
		expect(panel.state().history).toBe("playground");
		expect(versionRows().length).toBe(2);
		expect(panel.state().open).toBe(openBefore);

		panel.closeHistory();
		expect(labels()).toEqual(["playground", "product-list"]);
	});

	it("every screen row offers its history, and no other row does", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		rowFor("playground").click();

		expect(rowFor("playground").querySelector(".ly-hist")).not.toBeNull();
		// A screen's history is about the whole design; the rows under it are
		// about one element each.
		expect(rowFor("div.playground-root").querySelector(".ly-hist")).toBeNull();
	});

	it("opening a history is not selecting the screen", async () => {
		stubFetch();
		panel = new LayersPanel(host);
		const hist = rowFor("playground").querySelector(".ly-hist") as HTMLElement;

		hist.click();
		await new Promise((r) => setTimeout(r, 0));
		expect(panel.state().history).toBe("playground");
		expect(selectCalls).toEqual([]);
	});
});

describe("the plugin's own wiring", () => {
	it("documents every method it publishes", () => {
		const handle = plugin.mount({
			host,
			getCamera: () => ({ x: 0, y: 0, z: 1 }),
			getOrigin: () => ({ x: 0, y: 0 }),
			getViewport: () => ({ width: 1440, height: 900 }),
			getAppearance: () => "light",
			getZoom: () => 1,
			viewportCenterPage: () => ({ x: 0, y: 0 }),
			screenAt: () => null,
			objects: {
				register() {},
				unregister() {},
				layout: () => undefined,
				setLayout() {},
				beginMove() {},
				beginResize() {},
				select() {},
				selectedId: () => null,
			},
		});
		expect(handle).not.toBeNull();
		expect(checkApiDocs("layers", handle?.api, plugin.describe)).toEqual([]);
		handle?.destroy?.();
	});
});

describe("the helpers, on their own", () => {
	it("labels a node the way the outline badge does", () => {
		const el = document.createElement("div");
		expect(labelOf(el)).toBe("div");
		el.className = "lp-hero is-wide";
		expect(labelOf(el)).toBe("div.lp-hero");
	});

	it("drops chrome from a child list", () => {
		const parent = document.createElement("div");
		const keep = document.createElement("span");
		const drop = document.createElement("div");
		drop.setAttribute("data-ruler-host", "");
		parent.append(keep, drop);
		expect(listChildren(parent)).toEqual([keep]);
	});

	it("falls back to the scroller for a frame with no content wrapper", () => {
		// Older frames, and any test DOM that does not build one. The tree
		// should still have a root rather than no screen at all.
		const doc = document.implementation.createHTMLDocument();
		const group = doc.createElement("div");
		group.setAttribute("data-screen-id", "bare");
		const scroll = doc.createElement("div");
		scroll.setAttribute("data-screen-scroll", "bare");
		group.appendChild(scroll);
		doc.body.appendChild(group);
		expect(screenRoots(doc)).toEqual([{ id: "bare", root: scroll }]);
	});
});
