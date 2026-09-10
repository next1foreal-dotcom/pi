import type { LabPlugin, LabPluginContext, LabPluginHandle } from "../../plugin-api";
import { pushHistory, type HistoryCommand } from "../../core/history";
import { SKIP_HOSTS } from "../inspect/plugin";
import { locateElement, locateElementSourced, type SourceLocation } from "../inspect/source-location";

/**
 * Double-click a piece of copy on the canvas and change it, in place.
 *
 * The three pieces this sits on top of already worked: `inspect` says which
 * line of JSX made a node, the properties panel writes that node's classes, and
 * `POST /__lab-fs/element/text` rewrites the node's static text child. What was
 * missing was a hand on the third one — until now the only callers were her
 * tool and curl, so the copy on the screen was the one thing on the canvas he
 * could not change by touching it.
 *
 * ── in place, not in a floating box ──────────────────────────────────────
 * The editor IS the element: `contenteditable` goes on the node he
 * double-clicked. Screen content lives inside the camera transform, so a caret
 * put there is already at the right size, in the right place, and stays there
 * while he pans and zooms. A floating input would have needed the whole
 * coordinate round trip — client rect, camera, origin, zoom — recomputed on
 * every camera write, to end up looking like what the browser does for free.
 *
 * The cost is that this writes into DOM React rendered. That is survivable
 * here because of what the edit does next, which was measured rather than
 * assumed: writing a screen's source makes this vite dev server do a FULL PAGE
 * RELOAD, not a module swap. Probed by hand-writing a sentinel into a
 * neighbouring element's text and then committing an edit — the sentinel was
 * gone and the file's own copy was back. So nothing this plugin puts in the DOM
 * outlives one edit, and the reload that follows is what decides what is on
 * screen. Cancelling puts the original text back, which is the same job done by
 * hand.
 *
 * The one thing that would break it is a screen re-rendering for its own
 * reasons mid-edit — an interval, an animation with state. Not observed on the
 * screens here, and if it ever shows up, this is the paragraph that says why a
 * floating box would be the answer.
 *
 * ── what it will not open on ─────────────────────────────────────────────
 * `editText` on the server accepts one shape: an element whose children are a
 * single static text child. This side refuses the same shape in the DOM
 * (`plainTextOf`) so the caret does not appear somewhere the write would be
 * thrown out. It is an approximation of the server's rule, not a copy of it,
 * and it is deliberately the narrower of the two — the server stays the
 * authority, and when it does refuse, its sentence is what gets shown.
 */

/** How the endpoint is addressed. Same guard header as the classes write. */
const ENDPOINT = "/__lab-fs/element/text";
const WRITE_GUARD = "x-lab-canvas";

/** The only files whose JSX tags the server will touch. Mirrors EDITABLE_SOURCE. */
const EDITABLE_SOURCE = /\.[jt]sx$/;

/** Shown when a double-click landed on copy this cannot take apart. */
export const NOT_PLAIN_NOTE = "这块里面不止一段文字 · 双击里面那一段";

const HINT_NOTE = "回车写入 · Esc 取消";

/** Long enough to read a filename, short enough not to sit in the way. */
const DONE_MS = 1600;

export type TextRefusal =
	| "not-locked"
	| "other-screen"
	| "not-screen-content"
	| "not-plain-text"
	| "no-location"
	| "not-jsx-source";

/** The handle on one JSX tag, in the coordinates `locateElement` reports. */
export type EditTarget = {
	file: string;
	line: number;
	column: number;
	tag: string;
};

export type EditDecision =
	| { verdict: "edit"; target: EditTarget }
	/** The shape is right; the module's source map has not been read yet. */
	| { verdict: "edit-pending" }
	| { verdict: "refuse"; refusal: TextRefusal };

/** Everything the rule below needs, flattened so it is testable without a canvas. */
export type EditCandidate = {
	/** `window.lab.canvas.state().mode`. */
	mode: string;
	focusedId: string | null;
	/** The screen this element is in, or null if it is in none. */
	screenId: string | null;
	/** False for lab chrome, and for the screen's scroller itself. */
	inScreenContent: boolean;
	/** The element's single text child, or null when it has anything else. */
	plainText: string | null;
	tag: string;
	file: string | null;
	line: number | null;
	column: number | null;
	problem: string | null;
};

/**
 * Whether this double-click opens an editor, and if not, which rule stopped it.
 *
 * Pure, and ordered on purpose: the extension check runs before the coordinate
 * check, because `source-map-pending` carries a real `file` with null numbers.
 * Reversing the two would send every first double-click after a hot reload
 * down the pending path even when the file was never editable.
 */
export function decideEdit(c: EditCandidate): EditDecision {
	if (c.mode !== "focus" && c.mode !== "fill") return { verdict: "refuse", refusal: "not-locked" };
	if (!c.inScreenContent) return { verdict: "refuse", refusal: "not-screen-content" };
	if (c.focusedId === null || c.screenId !== c.focusedId) {
		return { verdict: "refuse", refusal: "other-screen" };
	}
	if (c.plainText === null) return { verdict: "refuse", refusal: "not-plain-text" };
	if (c.file === null) return { verdict: "refuse", refusal: "no-location" };
	if (!EDITABLE_SOURCE.test(c.file)) return { verdict: "refuse", refusal: "not-jsx-source" };
	if (c.problem === "source-map-pending") return { verdict: "edit-pending" };
	if (c.problem !== null || c.line === null || c.column === null) {
		return { verdict: "refuse", refusal: "no-location" };
	}
	return { verdict: "edit", target: { file: c.file, line: c.line, column: c.column, tag: c.tag } };
}

/**
 * The element's text, but only when its children are exactly one text node.
 *
 * Whitespace-only counts as nothing: a spacer div holding a newline is not copy
 * he meant to edit, and opening a caret in one would put the gesture in front
 * of whatever the app wanted with it.
 */
export function plainTextOf(el: Element): string | null {
	if (el.childNodes.length !== 1) return null;
	const only = el.firstChild;
	if (!only || only.nodeType !== Node.TEXT_NODE) return null;
	const text = only.nodeValue ?? "";
	return text.trim() ? text : null;
}

/**
 * Which screen this node's copy belongs to, or null when it is not a screen's
 * copy at all. Same two tests the inspect plugin makes, and the same reason:
 * lab chrome sits over the screens, and the scroller is the lab's, not the
 * app's.
 */
export function screenContentOf(el: Element): { screenId: string | null } | null {
	if (el.closest(SKIP_HOSTS)) return null;
	const scroll = el.closest("[data-screen-scroll]");
	if (!scroll || el === scroll) return null;
	return { screenId: el.closest("[data-screen-id]")?.getAttribute("data-screen-id") ?? null };
}

/**
 * What a contenteditable hands back -> what belongs in the file.
 *
 * `\s` already covers the non-breaking spaces a browser inserts, so one collapse
 * does both jobs. Newlines go the same way: JSX folds them into a single space
 * when it renders, so keeping one would change the file without changing the
 * screen — and then the next diff is noise.
 */
export function normalizeEdited(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/** Plain text only, with the spacing kept — the caret may be mid-word. */
export function pastedText(data: { getData(type: string): string } | null | undefined): string {
	return (data?.getData("text/plain") ?? "").replace(/\s+/g, " ");
}

export type TextEditBody = {
	file: string;
	line: number;
	column: number;
	tag: string;
	text: string;
};

/** The request body, exactly as `/__lab-fs/element/text` reads it. */
export function textEditBody(target: EditTarget, text: string): TextEditBody {
	return {
		file: target.file,
		line: target.line,
		column: target.column,
		tag: target.tag.toLowerCase(),
		text: normalizeEdited(text),
	};
}

/** The part of the endpoint's answer a history step can be built on. */
export type TextEditReply = {
	ok?: boolean;
	/** The refusal sentence, when there is one. */
	error?: string;
	changed?: boolean;
	before?: string;
	after?: string;
};

/**
 * The step that takes one typed sentence back, or null when there is none.
 *
 * Both directions are the same request with a different word in it, so this is
 * the whole of it: `before` is what the file said, `after` is what he typed, and
 * each direction expects to find the other one still in place. Between the edit
 * and his Ctrl+Z that line can have changed underneath — he edited it, or she
 * did — and writing back blind would take that with it.
 *
 * Null when the file did not change, and null when the answer did not say what
 * it replaced: a step with no `before` has nothing to write back.
 */
export function textEditCommand(body: TextEditBody, reply: TextEditReply): HistoryCommand | null {
	if (reply.ok !== true || reply.changed !== true) return null;
	if (typeof reply.before !== "string" || typeof reply.after !== "string") return null;
	return {
		type: "source-edit",
		endpoint: "text",
		what: `改 ${body.file.split("/").pop() ?? body.file}:${body.line} 的文字`,
		// Not `expectFor`: this route compares `expect` against the text itself,
		// which is always a string. There is no "the text is not there" state to
		// say null for -- a tag with no static text child is refused outright --
		// so null here would match nothing and refuse every step.
		undo: { body: { ...body, text: reply.before }, expect: reply.after },
		redo: { body: { ...body, text: reply.after }, expect: reply.before },
	};
}

/**
 * What to show after a write, or null when there is nothing to say.
 *
 * The server's sentence is used verbatim. It knows things this side does not —
 * which tag it actually found at that line, whether the children were an
 * expression, why the location is stale — and paraphrasing it here would give
 * him a friendlier message that is worth less.
 */
export function refusalNote(status: number, body: unknown): string | null {
	const bag = (body && typeof body === "object" ? body : {}) as { ok?: unknown; error?: unknown };
	if (status >= 200 && status < 300 && bag.ok === true) return null;
	if (typeof bag.error === "string" && bag.error.trim()) return bag.error;
	return `写不进去(HTTP ${status})`;
}

/**
 * What to say about a double-click this plugin refused.
 *
 * Almost always nothing. A refusal usually means the gesture was aimed at
 * something else — the canvas in explore mode, an app's own handler — and a lab
 * message over one of those is this plugin talking about a gesture it was never
 * part of. The single exception is a tag with visible copy in it that is not
 * one piece of text, because that is the case where he did aim at this and
 * nothing happened.
 */
export function localNote(decision: EditDecision, text: string): string | null {
	if (decision.verdict !== "refuse") return null;
	if (decision.refusal !== "not-plain-text") return null;
	return text.trim() ? NOT_PLAIN_NOTE : null;
}

const STYLE_ID = "lab-text-style";
const CSS = `
.lt-note{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);
 max-width:min(560px,calc(100vw - 32px));display:none;padding:6px 10px;border-radius:6px;
 pointer-events:none;background:var(--lab-pill,rgba(28,28,28,.92));color:var(--lab-chrome,#f1f1f1);
 font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;white-space:pre-wrap;
 box-shadow:0 8px 30px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);z-index:8}
.lt-note[data-show]{display:block}
.lt-note[data-bad]{color:#f39a5e}
[data-lab-text-editing]{cursor:text;user-select:text;-webkit-user-select:text;
 outline:1px solid var(--lab-accent,#1c1c1c);outline-offset:2px;border-radius:2px}
`;

function injectStyle(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

export type TextEditorDeps = {
	/** `window.lab.canvas.state()`, or null before the bridge is published. */
	canvasState(): { mode: string; focusedId: string | null } | null;
	locate(el: Element): SourceLocation;
	locateSourced(el: Element): Promise<SourceLocation>;
	/** Insert plain text at the caret. `execCommand` keeps the undo stack. */
	insertPlain(text: string): void;
};

export const liveDeps: TextEditorDeps = {
	canvasState: () => window.lab?.canvas.state() ?? null,
	locate: (el) => locateElement(el),
	locateSourced: (el) => locateElementSourced(el),
	insertPlain: (text) => {
		document.execCommand("insertText", false, text);
	},
};

type Editing = {
	el: HTMLElement;
	/** The text as it was, byte for byte, so cancelling really cancels. */
	original: string;
	/** Whatever `contenteditable` was before, so this puts back what it found. */
	priorEditable: string | null;
	target: EditTarget | null;
	/** Set only on the pending path: the answer is still being read. */
	locating: Promise<SourceLocation> | null;
};

export class TextEditor {
	private readonly deps: TextEditorDeps;
	private readonly note: HTMLDivElement;
	private editing: Editing | null = null;
	private closed = false;
	private doneTimer: ReturnType<typeof setTimeout> | null = null;
	/** The write in flight, so a test (or a caller) can wait for the round trip. */
	private inFlight: Promise<boolean> = Promise.resolve(true);

	constructor(host: HTMLElement, deps: TextEditorDeps = liveDeps) {
		this.deps = deps;
		injectStyle();
		this.note = document.createElement("div");
		this.note.className = "lt-note";
		this.note.setAttribute("data-lab-text-note", "");
		this.note.setAttribute("role", "status");
		host.appendChild(this.note);

		// Capture, so the gesture is decided before the shield's own dblclick
		// (which locks into a screen) and before any handler inside the app.
		// Nothing is consumed unless an editor actually opens.
		window.addEventListener("dblclick", this.onDoubleClick, true);
		// Registered at mount, which is the point: the lab adds its own keydown
		// capture listener later in the same ref callback that mounts plugins
		// (lab-view's attachRoot mounts them, then adds the listener), and it
		// turns Escape into "leave this screen" even while typing. Two capture
		// listeners on the same window fire in registration order, so this one
		// gets Escape first and the lab never sees it. Verified in the browser:
		// Escape during an edit restores the copy and leaves the canvas in fill.
		//
		// It is an ordering dependency, so what happens if it ever breaks
		// matters: the lab would exit the screen AND this would still cancel the
		// edit, because both listeners run. Annoying, not lossy.
		window.addEventListener("keydown", this.onKeyDown, true);
		window.addEventListener("pointerdown", this.onPointerDown, true);
	}

	// ── reading the page ────────────────────────────────────────────────

	private candidateFor(el: Element): { decision: EditDecision; text: string } {
		const state = this.deps.canvasState();
		const place = screenContentOf(el);
		const plain = plainTextOf(el);
		const loc = place ? this.deps.locate(el) : null;
		const decision = decideEdit({
			mode: state?.mode ?? "explore",
			focusedId: state?.focusedId ?? null,
			screenId: place?.screenId ?? null,
			inScreenContent: place !== null,
			plainText: plain,
			tag: el.tagName.toLowerCase(),
			file: loc?.file ?? null,
			line: loc?.line ?? null,
			column: loc?.column ?? null,
			problem: loc?.problem ?? null,
		});
		return { decision, text: plain ?? el.textContent ?? "" };
	}

	// ── the gesture ─────────────────────────────────────────────────────

	private onDoubleClick = (e: MouseEvent): void => {
		if (this.closed) return;
		const el = e.target;
		if (!(el instanceof HTMLElement)) return;
		if (this.editing && this.editing.el.contains(el)) return;
		const { decision, text } = this.candidateFor(el);
		if (decision.verdict === "refuse") {
			this.say(localNote(decision, text), false);
			return;
		}
		// Only now: everything above left the event alone, so a double-click
		// this plugin does not want still reaches whoever else does.
		e.preventDefault();
		e.stopPropagation();
		this.begin(el, decision);
	};

	private onPointerDown = (e: Event): void => {
		const open = this.editing;
		if (!open) return;
		const t = e.target;
		// Inside the text he is editing: that is the caret moving, not leaving.
		if (t instanceof Node && open.el.contains(t)) return;
		this.inFlight = this.commit();
	};

	/**
	 * Enter and Escape, taken before the lab sees them.
	 *
	 * Enter would not need this — `dispatchLabKey` already passes everything but
	 * Escape through on a typing target — but Escape would: in a locked mode the
	 * lab spends it on leaving the screen, typing target or not. One listener
	 * for both keeps the two answers in one place.
	 */
	private onKeyDown = (e: KeyboardEvent): void => {
		const open = this.editing;
		if (!open) return;
		const t = e.target;
		if (!(t instanceof Node) || !open.el.contains(t)) return;
		if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
			// A newline in a JSX text child renders as a space, so Enter has
			// nothing to insert here. It ends the edit instead.
			e.preventDefault();
			e.stopImmediatePropagation();
			this.inFlight = this.commit();
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopImmediatePropagation();
			this.cancel();
		}
	};

	private onPaste = (e: ClipboardEvent): void => {
		if (!this.editing) return;
		e.preventDefault();
		const text = pastedText(e.clipboardData);
		if (text) this.deps.insertPlain(text);
	};

	// ── the editor ──────────────────────────────────────────────────────

	/** Open the editor on a node. Returns false if that node is not editable. */
	/**
	 * Would `begin` take this node, if the canvas were locked into its screen?
	 *
	 * `begin` refuses in explore mode, which is the honest answer for the
	 * gesture -- a double-click out there is not an edit. But a toolbar button
	 * on a selected element can lock in first and then edit, and it needs to
	 * know whether to offer that BEFORE moving the camera. Asking `begin` would
	 * mean flying to the screen to find out the answer was no.
	 *
	 * So: the same rule, with the mode question already answered. Everything
	 * else -- one static text child, a source location, an editable file -- is
	 * decided by the same `decideEdit` the gesture uses, which is the point.
	 * Two copies of this rule would drift, and the copy that drifts is the one
	 * that puts a button in front of a write the server will refuse.
	 */
	canEdit(el: Element): boolean {
		if (this.closed || !(el instanceof HTMLElement)) return false;
		const place = screenContentOf(el);
		if (!place?.screenId) return false;
		const loc = this.deps.locate(el);
		return (
			decideEdit({
				mode: "focus",
				focusedId: place.screenId,
				screenId: place.screenId,
				inScreenContent: true,
				plainText: plainTextOf(el),
				tag: el.tagName.toLowerCase(),
				file: loc?.file ?? null,
				line: loc?.line ?? null,
				column: loc?.column ?? null,
				problem: loc?.problem ?? null,
			}).verdict !== "refuse"
		);
	}

	begin(el: Element, known?: EditDecision): boolean {
		if (this.closed || !(el instanceof HTMLElement)) return false;
		const decision = known ?? this.candidateFor(el).decision;
		if (decision.verdict === "refuse") return false;
		if (this.editing) this.inFlight = this.commit();

		const original = el.firstChild?.nodeValue ?? el.textContent ?? "";
		const priorEditable = el.getAttribute("contenteditable");
		// Engines without plaintext-only leave the element uneditable rather
		// than erroring, so the value is read back rather than assumed. Rich
		// editing is harmless as a fallback: `paste` is intercepted and only
		// textContent is ever read.
		el.setAttribute("contenteditable", "plaintext-only");
		if (!el.isContentEditable) el.setAttribute("contenteditable", "true");
		el.setAttribute("data-lab-text-editing", "");
		el.addEventListener("paste", this.onPaste);
		this.editing = {
			el,
			original,
			priorEditable,
			target: decision.verdict === "edit" ? decision.target : null,
			locating: decision.verdict === "edit-pending" ? this.deps.locateSourced(el) : null,
		};
		this.focusAll(el);
		this.say(HINT_NOTE, false);
		return true;
	}

	/**
	 * Caret in, whole label selected. Selecting all rather than the word the
	 * browser would have picked: these are labels and headings, and replacing
	 * one wholesale is what a double-click on it means here.
	 */
	private focusAll(el: HTMLElement): void {
		try {
			el.focus({ preventScroll: true });
			const sel = document.getSelection();
			if (!sel) return;
			const range = document.createRange();
			range.selectNodeContents(el);
			sel.removeAllRanges();
			sel.addRange(range);
		} catch {
			// jsdom, and any engine that dislikes a selection here. The edit is
			// still usable; it just starts with the caret wherever it landed.
		}
	}

	/** Take the editor off the node, leaving whatever text is in it. */
	private end(open: Editing): void {
		open.el.removeEventListener("paste", this.onPaste);
		if (open.priorEditable === null) open.el.removeAttribute("contenteditable");
		else open.el.setAttribute("contenteditable", open.priorEditable);
		open.el.removeAttribute("data-lab-text-editing");
		open.el.blur();
		this.editing = null;
	}

	/** Put the file's copy back on screen. Used whenever nothing was written. */
	private restore(open: Editing): void {
		open.el.textContent = open.original;
	}

	cancel(): void {
		const open = this.editing;
		if (!open) return;
		this.end(open);
		this.restore(open);
		this.say(null, false);
	}

	/**
	 * Write what he typed, then get out of the way.
	 *
	 * The editor closes before the request goes out, not after. A successful
	 * write reloads the page a second or two later (see the header), so a caret
	 * left open is a caret in a page that is about to be thrown away — and that
	 * reads as the edit having been lost. The properties panel does the opposite
	 * (it finds its element again) because class edits come in runs; this one is
	 * a single act, and the reload that follows is the answer.
	 */
	async commit(): Promise<boolean> {
		const open = this.editing;
		if (!open) return false;
		const next = normalizeEdited(open.el.textContent ?? "");
		this.end(open);

		if (next === normalizeEdited(open.original)) {
			// Nothing typed. Writing anyway would rewrite the module and repaint
			// the canvas to show exactly what is already there.
			this.restore(open);
			this.say(null, false);
			return true;
		}

		let target = open.target;
		if (!target && open.locating) {
			const loc = await open.locating;
			if (loc.problem === null && loc.file !== null && loc.line !== null && loc.column !== null) {
				target = { file: loc.file, line: loc.line, column: loc.column, tag: open.el.tagName.toLowerCase() };
			}
		}
		if (!target) {
			this.restore(open);
			this.say("找不到这段文字在源码里的位置,没有写", true);
			return false;
		}

		const body = textEditBody(target, next);
		this.say("写入中…", false);
		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json", [WRITE_GUARD]: "1" },
				body: JSON.stringify(body),
			});
			const parsed = (await res.json()) as unknown;
			const bad = refusalNote(res.status, parsed);
			if (bad !== null) {
				// The file did not change, so the canvas must not go on showing
				// copy that is not in it.
				this.restore(open);
				this.say(bad, true);
				return false;
			}
			// Onto the same stack as everything else on this canvas, so one
			// Ctrl+Z walks back through what he did in the order he did it.
			const step = textEditCommand(body, parsed as TextEditReply);
			if (step) pushHistory(step);
		} catch (error) {
			// The dev server is gone, or the page is being torn down. Without
			// this the note sits on "写入中…", which reads as still working.
			this.restore(open);
			this.say(`写不进去(${String(error)})`, true);
			return false;
		}
		this.say(`已写入 ${body.file.split("/").pop()}:${body.line}`, false, DONE_MS);
		return true;
	}

	// ── the one line it can put on screen ───────────────────────────────

	private say(text: string | null, bad: boolean, clearAfter?: number): void {
		if (this.doneTimer !== null) {
			clearTimeout(this.doneTimer);
			this.doneTimer = null;
		}
		this.note.textContent = text ?? "";
		this.note.toggleAttribute("data-show", text !== null);
		this.note.toggleAttribute("data-bad", text !== null && bad);
		if (text !== null && clearAfter !== undefined) {
			this.doneTimer = setTimeout(() => {
				this.doneTimer = null;
				if (!this.closed) this.say(null, false);
			}, clearAfter);
		}
	}

	/** What the note is showing right now, and what is being edited. */
	state(): {
		editing: boolean;
		file: string | null;
		line: number | null;
		text: string | null;
		note: string | null;
	} {
		const open = this.editing;
		return {
			editing: open !== null,
			file: open?.target?.file ?? null,
			line: open?.target?.line ?? null,
			text: open ? (open.el.textContent ?? "") : null,
			note: this.note.hasAttribute("data-show") ? this.note.textContent : null,
		};
	}

	/** Resolves once the write started by the last Enter or click-away is done. */
	settled(): Promise<boolean> {
		return this.inFlight;
	}

	destroy(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.editing) this.cancel();
		if (this.doneTimer !== null) {
			clearTimeout(this.doneTimer);
			this.doneTimer = null;
		}
		window.removeEventListener("dblclick", this.onDoubleClick, true);
		window.removeEventListener("keydown", this.onKeyDown, true);
		window.removeEventListener("pointerdown", this.onPointerDown, true);
		this.note.remove();
	}
}

export const plugin: LabPlugin = {
	id: "text",
	order: 66,
	// No hostSelector, for the reason the properties panel gives: the chrome
	// host is hidden in exactly the modes this plugin works in, and the layer
	// holding the screens carries the camera transform. The lab-made host is
	// neither.
	describe: [
		{
			name: "state",
			signature:
				"state(): { editing: boolean; file: string | null; line: number | null; text: string | null; note: string | null }",
			summary:
				"What is being edited right now, and the one line the lab is showing about it. `editing` is false between edits; `file` and `line` are null until the element's source map has been read, which is why an edit can be open with both still null. `note` is null when nothing is on screen.",
		},
		{
			name: "begin",
			signature: "begin(el: Element): boolean",
			summary:
				"Open the editor on a node you already have, skipping the double-click. Returns false and changes nothing unless the canvas is locked into the screen that node is in AND the node's only child is a piece of static text — the same rule the gesture uses. Any edit already open is committed first.",
		},
		{
			name: "canEdit",
			signature: "canEdit(el: Element): boolean",
			summary:
				"Whether `begin` would take this node once the canvas is locked into its screen — the same rule `begin` uses, with the mode question already answered. Use it to decide whether to OFFER an edit before moving the camera; `begin` itself still refuses in explore mode, which is correct for the double-click. False for anything outside screen content, anything whose only child is not a piece of static text, and anything whose source cannot be placed in an editable file.",
		},
		{
			name: "commit",
			signature: "commit(): Promise<boolean>",
			summary:
				"Write what is in the editor and close it, as Enter does. True when the file was written or there was nothing to write; false when the write was refused — read `state().note` for the server's own sentence. Resolves after the round trip, so it is the thing to await.",
		},
		{
			name: "cancel",
			signature: "cancel(): void",
			summary: "Close the editor and put the file's copy back on screen, as Escape does. Writes nothing.",
		},
	],
	mount(ctx: LabPluginContext): LabPluginHandle | null {
		if (typeof document === "undefined") return null;
		const editor = new TextEditor(ctx.host);
		return {
			api: {
				state: () => editor.state(),
				begin: (el: Element) => editor.begin(el),
				canEdit: (el: Element) => editor.canEdit(el),
				commit: () => editor.commit(),
				cancel: () => {
					editor.cancel();
				},
			},
			destroy: () => editor.destroy(),
		};
	},
};

export default plugin;
