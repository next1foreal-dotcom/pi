import type { LabPlugin, LabPluginContext, LabPluginHandle } from "../../plugin-api";
import type { ComponentIndex } from "../../components/types";
import { expectFor, pushHistory, type HistoryCommand } from "../../core/history";
import { INDEX_URL } from "../components/plugin";
import {
	fiberOf,
	findBySourceLocation,
	primeSourceLocations,
	type SourceTarget,
} from "../inspect/source-location";
import {
	Knobs,
	type KnobsDeps,
	type KnobsState,
	type KnobsTarget,
	type PropReply,
	type PropsFiber,
} from "./knobs";

/**
 * What is selected, and what can be changed about it.
 *
 * The lab could already point at a tag and say which line made it, and she
 * could already change that tag's classes through a tool. He could not: he had
 * to read the answer off a chip and go type in the file. This is the same
 * capability with his hands on it.
 *
 * It writes through `/__lab-fs/element/classes`, which runs the SAME editor her
 * tool runs (`jsx-class-list.ts`). That is deliberate: a panel that were looser
 * than the tool about which bytes of his source it will rewrite would be the
 * more dangerous of the two, because it is the one used without thinking. A
 * stale location is refused here exactly as it is there, and a computed
 * `className={cn(...)}` is refused by name rather than guessed at.
 */

type Selection = {
	screenId: string | null;
	file: string | null;
	line: number | null;
	column: number | null;
	component: string | null;
	tag: string | null;
	className: string | null;
	text: string | null;
	attached: boolean;
	problem: string | null;
};

type InspectApi = {
	selection(): Selection | null;
	selectAt(x: number, y: number): Selection | null;
	/** Optional because this panel does not own that plugin's shape. */
	selectElement?(el: Element): Selection | null;
};

/** One class-list edit, as it goes over the wire. */
export type ClassChange = { add?: string; remove?: string };

/** The tag a class edit landed on, exactly as the endpoint is addressed. */
export type ClassEditWhere = { file: string; line: number; column: number; tag: string };

/** The part of the endpoint's answer a history step can be built on. */
export type ClassEditReply = {
	ok?: boolean;
	/** The refusal sentence, when there is one. */
	error?: string;
	changed?: boolean;
	before?: string;
	after?: string;
};

/**
 * The step that takes one class edit back, or null when there is nothing to
 * take back.
 *
 * Both directions write the whole list the endpoint just reported (`before` to
 * undo, `after` to redo). Reversing a removal as an add would append the name,
 * so a list he wrote as `lp-btn is-ghost` comes back `is-ghost lp-btn` — same
 * classes, a line he never typed, and every undo/redo shuffles it again.
 *
 * Null for a write that did not change the file: a step that applies cleanly
 * and changes nothing is a Ctrl+Z that appears to do nothing at all, which is
 * the hardest kind of undo bug to see. Null too when the answer did not say
 * what it replaced, because then there is no value to compare against later and
 * the undo would be writing blind.
 */
export function classEditCommand(
	where: ClassEditWhere,
	change: ClassChange,
	reply: ClassEditReply,
): HistoryCommand | null {
	if (reply.ok !== true || reply.changed !== true) return null;
	if (typeof reply.before !== "string" || typeof reply.after !== "string") return null;
	if (!change.add && !change.remove) return null;
	// The endpoint treats `replace` as given only when `body.replace.trim() !== ""`.
	// An empty string is therefore "not given", not "clear the attribute". Do not
	// change that: her tool (`element-edit.ts`) exposes `replace` as an optional
	// string, and flipping "" from omitted to "wipe the list" would turn a missed
	// argument into a destructive write. An add onto a tag that had no className
	// undoes by removing the names this edit put there (the dropped-attribute
	// path). The same for redoing a write that lifted the attribute.
	const undoBody =
		reply.before === ""
			? { ...where, remove: change.add }
			: { ...where, replace: reply.before };
	const redoBody =
		reply.after === ""
			? { ...where, remove: change.remove }
			: { ...where, replace: reply.after };
	return {
		type: "source-edit",
		endpoint: "classes",
		what: change.remove ? `拿掉 ${change.remove}` : `加上 ${change.add}`,
		undo: { body: undoBody, expect: expectFor(reply.after) },
		redo: { body: redoBody, expect: expectFor(reply.before) },
	};
}

/** The element to look for again, once the write has landed. */
export type RefindTarget = SourceTarget & { screenId: string | null };

export type RefindLimit = { attempts: number; intervalMs: number };

/**
 * Long enough for a save-to-repaint round trip on a slow machine, short enough
 * that the panel is not still claiming to be working when he has moved on.
 */
export const REFIND_LIMIT: RefindLimit = { attempts: 24, intervalMs: 120 };

/**
 * Is the edit we just made visible on this node?
 *
 * The source position survives the write, which is the whole reason the panel
 * can find its way back — but so does the OLD node, right up until the reload
 * lands, and it is standing at exactly that position. Position alone would
 * therefore hand back the node that is about to disappear.
 *
 * Asking whether the class we wrote is on it separates the two, and does it
 * without knowing anything about how vite reloads. It also gets the case where
 * nothing is going to reload right: the server does not write the file when the
 * edit changes nothing (a class removed that was not there), so the node that
 * is already on screen is the answer, and this says so on the first look.
 *
 * Directional on purpose — added names must be present, removed names must be
 * gone — so a component that puts a class of its own on the node does not read
 * as a mismatch forever.
 */
export function editLanded(className: string | null, change: ClassChange): boolean {
	const have = new Set(classesOf(className));
	if (classesOf(change.remove ?? null).some((name) => have.has(name))) return false;
	return classesOf(change.add ?? null).every((name) => have.has(name));
}

/** What the live panel uses to look; a seam so the waiting can be tested. */
export type RefindDeps = {
	/** The screen's scroller, which outlives the modules rendered inside it. */
	root(screenId: string | null): ParentNode | null;
	/** New modules are served at new URLs, so their maps have to be read again. */
	prime(root: ParentNode): Promise<void>;
	find(root: ParentNode, target: SourceTarget, accept: (el: Element) => boolean): Element | null;
	wait(ms: number): Promise<void>;
};

export const liveRefindDeps: RefindDeps = {
	root(screenId) {
		if (screenId === null || typeof document === "undefined") return null;
		// Scanned rather than selected, so a screen id with a quote in it is a
		// miss instead of a thrown selector.
		const all = document.querySelectorAll("[data-screen-scroll]");
		for (let i = 0; i < all.length; i += 1) {
			if (all[i].getAttribute("data-screen-scroll") === screenId) return all[i];
		}
		return null;
	},
	prime: (root) => primeSourceLocations(root),
	find: (root, target, accept) => findBySourceLocation(root, target, { accept }),
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Look for the edited element until it comes back, or until we have looked
 * enough times to say it is not coming.
 *
 * Polling and not a fixed wait, because the step that has to finish first is
 * reading the new modules' source maps, and how long that takes is a property
 * of the machine. A fixed wait is either too short on a slow one or wasted on a
 * fast one; this is neither, and it has a ceiling.
 */
export async function refind(
	target: RefindTarget,
	change: ClassChange,
	limit: RefindLimit = REFIND_LIMIT,
	deps: RefindDeps = liveRefindDeps,
): Promise<Element | null> {
	return pollForElement(
		target,
		(el) => editLanded(el.getAttribute("class"), change),
		limit,
		deps,
	);
}

/**
 * The waiting itself, with the "has it landed" question left to the caller.
 *
 * Two edits go through this now — a class list and a prop — and they know
 * different things about what the new render looks like. What they share is
 * every reason the wait exists, so that part is here once rather than twice.
 */
export async function pollForElement(
	target: RefindTarget,
	accept: (el: Element) => boolean,
	limit: RefindLimit = REFIND_LIMIT,
	deps: RefindDeps = liveRefindDeps,
): Promise<Element | null> {
	// A selection with no screen was never inside one, and no amount of waiting
	// changes that. A screen whose scroller is missing right now is a different
	// thing — that one is worth another look.
	if (target.screenId === null) return null;
	for (let attempt = 0; attempt < limit.attempts; attempt += 1) {
		const root = deps.root(target.screenId);
		if (root) {
			// New modules are served at new URLs, so the maps behind the
			// synchronous lookup have to be read again before it can answer.
			await deps.prime(root);
			const found = deps.find(root, target, accept);
			if (found) return found;
		}
		if (attempt < limit.attempts - 1) await deps.wait(limit.intervalMs);
	}
	return null;
}

const STYLE_ID = "lab-properties-style";
const CSS = `
.pp-panel{position:fixed;right:12px;top:12px;width:280px;max-height:calc(100vh - 24px);overflow:auto;
 backdrop-filter:blur(14px) saturate(1.08);-webkit-backdrop-filter:blur(14px) saturate(1.08);
 display:none;flex-direction:column;gap:8px;padding:10px 11px;border-radius:8px;pointer-events:auto;
 background:var(--lab-pill,rgba(28,28,28,.92));color:var(--lab-chrome,#f1f1f1);
 font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;
 box-shadow:0 8px 30px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);z-index:7}
.pp-panel[data-show]{display:flex}
.pp-tag{font:600 13px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-where{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.55;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-section{font:600 10px/1.2 ui-sans-serif,system-ui;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin-top:2px}
.pp-chips{display:flex;flex-wrap:wrap;gap:4px}
.pp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 6px;border-radius:4px;
 background:rgba(255,255,255,.09);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-chip button{all:unset;cursor:pointer;opacity:.5;padding:0 2px;line-height:1}
.pp-chip button:hover{opacity:1}
.pp-add,.pp-say{all:unset;box-sizing:border-box;width:100%;padding:3px 1px;
 border-bottom:1px solid rgba(255,255,255,.13)}
.pp-add{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-say{font:11px/1.4 ui-sans-serif,-apple-system,system-ui,sans-serif}
.pp-add:focus,.pp-say:focus{border-bottom-color:rgba(255,255,255,.42)}
.pp-add::placeholder,.pp-say::placeholder{opacity:.32}
.pp-say[hidden]{display:none}
.pp-note{font:11px/1.4 ui-sans-serif,system-ui;opacity:.62}
.pp-note:empty{display:none}
.pp-note[data-bad]{opacity:1;font-weight:600;padding-left:7px;
 border-left:2px solid rgba(255,255,255,.55)}
.pp-empty{opacity:.5;font-style:italic}
`;

function injectStyle(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

/** `"a  b"` -> `["a", "b"]`. */
export function classesOf(value: string | null): string[] {
	return (value ?? "").split(/\s+/).filter(Boolean);
}

/**
 * What the panel is allowed to offer, given a selection.
 *
 * Pure so the rule is testable without a DOM: the panel must not offer to edit
 * what the editor behind it would refuse, or every refusal arrives as a failed
 * write he has already committed to in his head.
 */
export function editability(sel: Selection | null): {
	show: boolean;
	editable: boolean;
	note: string | null;
	bad: boolean;
} {
	if (!sel) return { show: false, editable: false, note: null, bad: false };
	if (!sel.attached) {
		return { show: true, editable: false, note: "这个节点已经被热更新换掉了,重新点一下", bad: true };
	}
	if (sel.file === null || sel.line === null || sel.column === null) {
		return {
			show: true,
			editable: false,
			note: `找不到源码位置(${sel.problem ?? "no location"}),所以不能从这里改`,
			bad: true,
		};
	}
	if (!/\.[jt]sx$/.test(sel.file)) {
		return { show: true, editable: false, note: "只有 .tsx / .jsx 里的标签能从这里改", bad: true };
	}
	return { show: true, editable: true, note: null, bad: false };
}

/**
 * What the panel says when the edit landed but the element did not come back.
 *
 * It is the honest end of this path and it stays that way: a panel that went on
 * describing a node it could not find would be the one you edit the wrong thing
 * from next.
 */
const LOST_NOTE = "改好了 · 再点一下它继续改";

export type PropertiesOptions = {
	refind?: RefindLimit;
	deps?: RefindDeps;
	/** Injected by tests; the live panel talks to the dev server. */
	knobs?: Partial<KnobsDeps>;
	/**
	 * Say something about the selected element, from the panel that is already
	 * describing it.
	 *
	 * Pointing and speaking were two tools: shift-click opened this panel, and
	 * saying anything about what it showed meant leaving it, pressing `I`,
	 * finding the same element again and clicking 说这里. Two gestures for one
	 * intention, and the second one is not discoverable — 2026-09-09 he had been
	 * using this lab for days without knowing the point tool existed.
	 *
	 * Injected so the panel does not have to know how a note is made.
	 */
	say?: (text: string, selection: Selection) => void;
};

const EMPTY_INDEX: ComponentIndex = { screens: [], components: [], problems: [] };

/**
 * The component index, read straight from the server rather than through the
 * components plugin: `list()` drops the props and `show()` would paint outlines
 * on his canvas as a side effect of opening a panel. The server recomputes the
 * index per request, so this is never stale — it is only ever slow.
 */
async function fetchIndex(): Promise<ComponentIndex> {
	try {
		const res = await fetch(INDEX_URL);
		if (!res.ok) return EMPTY_INDEX;
		const body = (await res.json()) as { ok?: boolean; index?: ComponentIndex };
		return body.ok && body.index ? body.index : EMPTY_INDEX;
	} catch {
		return EMPTY_INDEX;
	}
}

/** Which component an element belongs to — the components plugin's own walk. */
async function componentAt(el: Element): Promise<string | null> {
	const api = window.lab?.plugin("components") as
		| { componentAt?(el: Element): Promise<string | null> }
		| undefined;
	if (!api || typeof api.componentAt !== "function") return null;
	return api.componentAt(el);
}

async function postProp(body: unknown): Promise<{ status: number; body: PropReply }> {
	const res = await fetch("/__lab-fs/element/prop", {
		method: "POST",
		headers: { "content-type": "application/json", "x-lab-canvas": "1" },
		body: JSON.stringify(body),
	});
	let parsed: PropReply = {};
	try {
		parsed = (await res.json()) as PropReply;
	} catch {
		parsed = {};
	}
	return { status: res.status, body: parsed };
}

export class Properties {
	private readonly limit: RefindLimit;
	private readonly deps: RefindDeps;
	private readonly panel: HTMLDivElement;
	private readonly tagEl: HTMLDivElement;
	private readonly whereEl: HTMLDivElement;
	private readonly say: HTMLInputElement;
	private readonly sayOut: PropertiesOptions["say"];
	private readonly chips: HTMLDivElement;
	private readonly add: HTMLInputElement;
	private readonly note: HTMLDivElement;
	private readonly knobs: Knobs;
	/** Clicks overtake each other; only the newest look may paint the knobs. */
	private knobGen = 0;
	/**
	 * The position the knobs were last drawn for.
	 *
	 * Kept apart from `shown` because of the order the browser uses: the click
	 * that turns a slider fires `pointerup` — which queues the sync that drops
	 * `shown` — BEFORE it delivers `change` to the control. So by the time a
	 * turn begins, the selection it belongs to is already gone, and it is gone
	 * for a reason that has nothing to do with him having moved on. This is what
	 * the write finds its way back to; `movedOn` is still what decides whether
	 * the selection is taken.
	 */
	private knobAnchor: RefindTarget | null = null;
	private shown: Selection | null = null;
	private busy = false;
	/** A write just landed; hold the message until the next real selection. */
	private pending = false;
	private closed = false;

	constructor(host: HTMLElement, opts: PropertiesOptions = {}) {
		this.limit = opts.refind ?? REFIND_LIMIT;
		this.deps = opts.deps ?? liveRefindDeps;
		this.sayOut = opts.say;
		injectStyle();
		this.panel = document.createElement("div");
		this.panel.className = "pp-panel";
		this.panel.dataset.labChrome = "";
		this.panel.setAttribute("data-properties-panel", "");

		this.tagEl = document.createElement("div");
		this.tagEl.className = "pp-tag";
		this.whereEl = document.createElement("div");
		this.whereEl.className = "pp-where";
		const classesLabel = document.createElement("div");
		classesLabel.className = "pp-section";
		classesLabel.textContent = "classes";
		this.chips = document.createElement("div");
		this.chips.className = "pp-chips";
		this.add = document.createElement("input");
		this.add.className = "pp-add";
		this.add.placeholder = "加一个类,回车";
		this.add.setAttribute("data-properties-add", "");
		this.say = document.createElement("input");
		this.say.className = "pp-say";
		this.say.placeholder = "跟她说这里,回车";
		this.say.setAttribute("data-properties-say", "");
		this.say.hidden = opts.say === undefined;
		this.note = document.createElement("div");
		this.note.className = "pp-note";

		this.panel.append(this.tagEl, this.whereEl, classesLabel, this.chips, this.add, this.say, this.note);
		this.knobs = new Knobs(this.panel, {
			loadIndex: fetchIndex,
			componentAt,
			fiberOf: (el) => fiberOf(el) as PropsFiber | null,
			post: postProp,
			settle: (check) => this.settle(check),
			busy: (on) => {
				this.busy = on;
				// Releasing is also the moment to look again: the selection either
				// came back or he has moved on, and both are read the same way.
				if (!on) this.sync();
			},
			...(opts.knobs ?? {}),
		});
		host.appendChild(this.panel);

		this.add.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const value = this.add.value.trim();
			if (value) void this.addClass(value);
		});

		this.say.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const text = this.say.value.trim();
			// Nothing typed is not a message. An empty note is a thing she then has
			// to answer about, and she already has to refuse one of those.
			if (!text || !this.shown || !this.sayOut) return;
			this.sayOut(text, this.shown);
			this.say.value = "";
			this.note.textContent = "说了。她会看到这一行的位置。";
			this.note.removeAttribute("data-bad");
		});
		// A click in the panel is not a click on the canvas: without this the
		// lab clears the selection the panel is describing, the instant he
		// reaches for it.
		this.panel.addEventListener("pointerdown", (e) => e.stopPropagation());
	}

	private inspect(): InspectApi | null {
		const api = window.lab?.plugin("inspect") as InspectApi | undefined;
		return api && typeof api.selection === "function" ? api : null;
	}

	sync = (): void => {
		if (this.closed || this.busy) return;
		const sel = this.inspect()?.selection() ?? null;
		const same =
			sel === this.shown ||
			(sel !== null &&
				this.shown !== null &&
				sel.file === this.shown.file &&
				sel.line === this.shown.line &&
				sel.column === this.shown.column &&
				sel.className === this.shown.className &&
				sel.attached === this.shown.attached);
		if (same) return;
		this.shown = sel;
		this.render();
		if (this.pending && sel) this.pending = false;
		else if (this.pending) {
			// Nothing selected yet: keep the "it worked" line up instead of
			// blanking the panel the instant the node it described went away.
			this.panel.setAttribute("data-show", "");
			this.note.textContent = LOST_NOTE;
		}
	};

	/**
	 * The element this selection points at, so the knobs can ask which component
	 * it belongs to. The selection carries a source position, not a node — this
	 * is the same lookup the class edits use to find their way back.
	 */
	private async knobTarget(sel: Selection | null): Promise<KnobsTarget> {
		if (!sel || !sel.attached || sel.file === null || sel.line === null || sel.column === null) {
			return { el: null, screenId: null };
		}
		const root = this.deps.root(sel.screenId);
		if (!root) return { el: null, screenId: sel.screenId };
		await this.deps.prime(root);
		const target: SourceTarget = { file: sel.file, line: sel.line, column: sel.column };
		return { el: this.deps.find(root, target, () => true), screenId: sel.screenId };
	}

	/** Point the knobs at the current selection, newest look wins. */
	private refreshKnobs(sel: Selection | null): void {
		const mine = ++this.knobGen;
		// Only ever replaced by a real selection, never cleared by the absence of
		// one — see `knobAnchor`.
		if (sel && sel.file !== null && sel.line !== null && sel.column !== null) {
			this.knobAnchor = {
				screenId: sel.screenId,
				file: sel.file,
				line: sel.line,
				column: sel.column,
			};
		}
		void this.knobTarget(sel).then((target) => {
			if (this.closed || mine !== this.knobGen) return;
			return this.knobs.update(target);
		});
	}

	/**
	 * Wait for a prop write to reach the screen, then hand the new node back to
	 * the inspect plugin — the same recovery the class edits do, with the value
	 * as the gate instead of the class name.
	 */
	private async settle(check: (el: Element) => boolean): Promise<Element | null> {
		const sel = this.shown;
		const target: RefindTarget | null =
			sel && sel.file !== null && sel.line !== null && sel.column !== null
				? { screenId: sel.screenId, file: sel.file, line: sel.line, column: sel.column }
				: this.knobAnchor;
		if (!target) return null;
		const back = await pollForElement(target, check, this.limit, this.deps);
		if (this.closed) return back;
		// Same rule as a class edit: his last click wins. Pulling the selection
		// back to the tag he turned a knob on would leave the panel describing
		// one element while he is looking at another.
		if (this.movedOn(target)) return back;
		if (back && this.claim(back)) {
			this.shown = null;
		} else if (!back) {
			this.note.textContent = LOST_NOTE;
			this.note.removeAttribute("data-bad");
		}
		return back;
	}

	private render(): void {
		const sel = this.shown;
		const state = editability(sel);
		this.panel.toggleAttribute("data-show", state.show);
		this.refreshKnobs(state.show ? sel : null);
		if (!sel || !state.show) return;

		this.tagEl.textContent = sel.component ? `<${sel.tag}> · ${sel.component}` : `<${sel.tag}>`;
		// The last two segments, because that is the part anyone reads: nobody
		// scans `packages/design-lab/src/screens/` to learn which file this is.
		// It used to be the whole path with `word-break: break-all`, which broke
		// it mid-word — `.../main-landing/p` then `age.tsx:73:6` — and made the
		// least useful line on the panel one of the tallest. The full path is on
		// hover, and 复制位置 on the element toolbar puts it on the clipboard.
		const where =
			sel.file && sel.line !== null ? `${sel.file}:${sel.line}:${sel.column}` : (sel.problem ?? "");
		this.whereEl.textContent = shortWhere(where);
		this.whereEl.title = where;

		this.chips.textContent = "";
		const names = classesOf(sel.className);
		if (names.length === 0) {
			const empty = document.createElement("span");
			empty.className = "pp-note pp-empty";
			empty.textContent = "没有 class";
			this.chips.appendChild(empty);
		}
		for (const name of names) {
			const chip = document.createElement("span");
			chip.className = "pp-chip";
			chip.dataset.class = name;
			chip.append(document.createTextNode(name));
			if (state.editable) {
				const x = document.createElement("button");
				x.type = "button";
				x.textContent = "×";
				x.title = `remove ${name}`;
				x.addEventListener("click", () => void this.removeClass(name));
				chip.appendChild(x);
			}
			this.chips.appendChild(chip);
		}

		this.add.style.display = state.editable ? "" : "none";
		this.note.textContent = state.note ?? "";
		this.note.toggleAttribute("data-bad", state.bad);
	}

	/**
	 * One edit, then the element again.
	 *
	 * The write makes vite replace the module, and the node this selection
	 * points at goes with it. Two ways back were tried and neither survives
	 * contact with the running lab: the old pixel usually moves, because the
	 * edit is why the layout changed, and the node's place in the tree does not
	 * find it either once the screen remounts.
	 *
	 * What does survive is the source position. `editClassList` never rewrites a
	 * byte before the tag name -- it changes the text inside `className="..."`,
	 * or lifts the whole attribute off -- so the `<` this selection was pointed
	 * at is at the same line and column after the edit as it was before. That is
	 * the handle, and it is matched in full: file and line alone would pick the
	 * wrong tag when two of them share a line.
	 *
	 * When it does not come back, say so and let the next click re-select,
	 * rather than leave the panel confidently describing a node that is no
	 * longer there -- that is how you edit the wrong thing next.
	 */
	private async write(change: ClassChange): Promise<void> {
		const sel = this.shown;
		if (!sel || !editability(sel).editable || this.busy) return;
		// editability() has already refused a selection missing any of these.
		const target: RefindTarget = {
			screenId: sel.screenId,
			file: sel.file as string,
			line: sel.line as number,
			column: sel.column as number,
		};
		this.busy = true;
		this.note.textContent = "写入中…";
		this.note.removeAttribute("data-bad");
		// `undefined` means the write never got as far as looking for the node,
		// so the note set on the way out is the one that stands.
		let back: Element | null | undefined;
		try {
			const res = await fetch("/__lab-fs/element/classes", {
				method: "POST",
				headers: { "content-type": "application/json", "x-lab-canvas": "1" },
				body: JSON.stringify({
					file: sel.file,
					line: sel.line,
					column: sel.column,
					tag: sel.tag,
					...change,
				}),
			});
			const body = (await res.json()) as ClassEditReply;
			if (!res.ok || !body.ok) {
				this.note.textContent = body.error ?? `写不进去(HTTP ${res.status})`;
				this.note.setAttribute("data-bad", "");
			} else {
				this.add.value = "";
				// Onto the same stack as every other thing he does here, before
				// the wait for the element: the step belongs to the write, and
				// the refind that follows can end in "never came back".
				const step = classEditCommand(
					{
						file: target.file,
						line: target.line,
						column: target.column,
						tag: String(sel.tag),
					},
					change,
					body,
				);
				if (step) pushHistory(step);
				back = await refind(target, change, this.limit, this.deps);
			}
		} catch (error) {
			// The dev server is gone, or the page is being torn down. Without
			// this the panel sits on the "writing" line forever, which reads as
			// still working.
			this.note.textContent = `写不进去(${String(error)})`;
			this.note.setAttribute("data-bad", "");
		} finally {
			this.busy = false;
		}
		if (back === undefined || this.closed) return;
		this.shown = null;
		// He may have shift-clicked something else while the reload was in
		// flight. His last click wins: pulling the selection back to what he
		// edited a moment ago would leave the panel describing one element while
		// he is looking at another, and the next remove would land on that one.
		if (this.movedOn(target) || (back !== null && this.claim(back))) {
			this.pending = false;
			this.sync();
			return;
		}
		this.pending = true;
		this.panel.setAttribute("data-show", "");
		// The chips are now a snapshot of a node we could not find, so the
		// controls on them come off: a × that quietly does nothing is worse than
		// no ×. What is left is readable, and says where it came from.
		// .forEach, not for..of: this package's lib is ES2023+DOM without
		// DOM.Iterable, so iterating a NodeList is a type error here.
		this.chips.querySelectorAll("button").forEach((b) => {
			b.remove();
		});
		this.add.style.display = "none";
		this.note.textContent = LOST_NOTE;
		this.note.removeAttribute("data-bad");
	}

	/** Has he selected some OTHER element since this write started? */
	private movedOn(target: RefindTarget): boolean {
		const now = this.inspect()?.selection() ?? null;
		if (!now || !now.attached) return false;
		return now.file !== target.file || now.line !== target.line || now.column !== target.column;
	}

	/** Hand the node back to the inspect plugin, which owns what is selected. */
	private claim(el: Element): boolean {
		return (this.inspect()?.selectElement?.(el) ?? null) !== null;
	}

	/**
	 * The two edits the chips and the input box make. Public so that driving the
	 * panel and clicking it are the same path, rather than two that can drift.
	 */
	removeClass(name: string): Promise<void> {
		return this.write({ remove: name });
	}

	addClass(name: string): Promise<void> {
		return this.write({ add: name });
	}

	/** What the knob half is offering right now. */
	knobState(): KnobsState {
		return this.knobs.read();
	}

	/** Turn one knob by name — the same path the control takes. */
	turnKnob(prop: string, value: string | number | boolean): Promise<void> {
		return this.knobs.turnByName(prop, value);
	}

	destroy(): void {
		this.closed = true;
		this.knobs.destroy();
		this.panel.remove();
	}
}

/** `main-landing/page.tsx:73:6` out of the repo-relative path. */
export function shortWhere(where: string): string {
	const parts = where.split("/");
	return parts.length <= 2 ? where : parts.slice(-2).join("/");
}

/** Page-space gap between a screen's right edge and a note about it. */
export const SAY_GAP = 24;

type NotesApi = {
	spawn(init: {
		x: number;
		y: number;
		text?: string;
		kind?: "sticky" | "comment";
		source?: { file: string; line: number; col: number; component: string | null };
	}): void;
};

/**
 * The panel's outlet: one line he typed, left on the canvas as a note that
 * carries where he was pointing.
 *
 * It goes through the notes plugin rather than writing the feed itself. The feed
 * is fed by the notes layer, and a second writer would be a second thing to keep
 * in step with it — the id, the author stamp, the git oid, the "still typing"
 * skip. This is the same door 说这里 walks through, opened from the panel that
 * is already describing the element instead of from a tool he has to know about.
 *
 * `source` is the point of the whole thing: file, line and column, so she reads
 * "he means this tag" rather than "he means somewhere on this screen".
 */
function speakFromPanel(ctx: LabPluginContext, text: string, sel: Selection): void {
	const notes = window.lab?.plugin("notes") as NotesApi | undefined;
	if (!notes) return;
	const frame = sel.screenId ? ctx.screenLayout?.(sel.screenId) : undefined;
	// Beside the frame, not on it: a note dropped over the design is a note he
	// then has to move before he can see what he was talking about.
	const at = frame ? { x: frame.x + frame.width + SAY_GAP, y: frame.y } : ctx.viewportCenterPage();
	notes.spawn({
		...at,
		text,
		// Not a sticky. A sticky is a thought parked on the canvas; this is a
		// remark aimed at one tag, and it gets the body that says so.
		kind: "comment",
		...(sel.file && sel.line !== null
			? {
					source: {
						file: sel.file,
						line: sel.line,
						col: sel.column ?? 0,
						component: sel.component,
					},
				}
			: {}),
	});
}

const plugin: LabPlugin = {
	id: "properties",
	order: 65,
	// No hostSelector on purpose. `[data-lab-chrome]` is display:none in the
	// locked modes -- exactly when this is wanted -- and the layer that holds
	// the screens carries the camera transform, which would turn this panel
	// position:fixed into position:absolute and slide it away with the canvas.
	// The lab-made plugin host is neither: absolute, inset 0, outside the
	// transform, pointer-events none with auto items -- the house pattern.
	describe: [
		{
			name: "say",
			signature: "say(text?: string): boolean",
			summary:
				"Leave a remark on the selected element: spawns a comment note beside that element's screen, carrying its file, line, column and component, and opens it for typing. Pass `text` to write it outright, or omit it to open an empty one — the same thing the panel's 跟她说这里 line does, reachable without the panel. Returns false and does nothing when nothing is selected.",
		},
		{
			name: "state",
			signature: "state(): { showing: boolean; file: string | null; classes: string[] } | null",
			summary:
				"What the panel is currently describing. Null before anything has been selected. `classes` is the class list it is offering to edit, which is empty both when the tag has none and when the selection is not editable — read `showing` with it.",
		},
		{
			name: "refresh",
			signature: "refresh(): void",
			summary:
				"Re-read the inspect plugin's selection now. The panel already follows clicks and camera writes; this is for a selection made through the api, which nothing else announces.",
		},
		{
			name: "knobs",
			signature:
				"knobs(): { showing, component, instance, rows: { name, kind, value, writable, note }[], warning }",
			summary:
				"The declared-editor controls for the component the selected element belongs to. Only props carrying an `@editor` tag appear — an inferred type is not enough to build a control from. `writable` is not a guess: the panel asks the source editor with a trial write it always refuses on the value, so every other gate (location, tag, literal, spread) has really passed. A false one carries the editor's own sentence in `note`, and its control is disabled before anyone touches it. `instance` is the call site being written; null with a `warning` when the screen has more than one and the panel will not guess between them.",
		},
	],
	mount(ctx: LabPluginContext): LabPluginHandle | null {
		if (typeof document === "undefined") return null;
		const panel = new Properties(ctx.host, {
			say: (text, sel) => speakFromPanel(ctx, text, sel),
		});
		// A selection only changes from a click or an api call. The first is
		// caught here, the second by refresh(); polling every frame to catch a
		// call nobody made would be paying rent on the rare case.
		const onUp = () => setTimeout(panel.sync, 0);
		window.addEventListener("pointerup", onUp, true);
		return {
			onCameraWrite: panel.sync,
			api: {
				/**
				 * The panel is one door to this, not the only one. The element
				 * toolbar is the other, and it is the one that is found without
				 * being told about.
				 */
				say: (text = "") => {
					const sel =
						(window.lab?.plugin("inspect") as InspectApi | undefined)?.selection() ?? null;
					if (!sel) return false;
					speakFromPanel(ctx, text, sel);
					return true;
				},
				state: () => {
					const sel = (window.lab?.plugin("inspect") as InspectApi | undefined)?.selection() ?? null;
					if (!sel) return null;
					return {
						showing: editability(sel).show,
						file: sel.file,
						classes: editability(sel).editable ? classesOf(sel.className) : [],
					};
				},
				refresh: () => panel.sync(),
				knobs: () => panel.knobState(),
			},
			destroy() {
				window.removeEventListener("pointerup", onUp, true);
				panel.destroy();
			},
		};
	},
};

export default plugin;
