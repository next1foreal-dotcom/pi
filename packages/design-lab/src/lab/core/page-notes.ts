/**
 * Page-space sticky notes for the Interaction Lab.
 *
 * Reference UX (viewport notes): github.com/timothymaarv/sticky-notes @ 7db1bbb —
 * no LICENSE file; read for mechanism, do not vendor.
 * Positions are page units and live inside the camera-transformed layer, so
 * notes pan/zoom with canvas content (Shift+N spawns at the viewport-center
 * page point).
 */

const MYNERVE_WOFF2 = "/fonts/mynerve/regular.woff2";
const MYNERVE_WOFF = "/fonts/mynerve/regular.woff";

export type NoteColor =
	| "yellow"
	| "orange"
	| "green"
	| "blue"
	| "purple"
	| "pink"
	| "white"
	| "black";

export type NoteFontSize = "small" | "medium" | "large" | "huge";

export type NoteFont = "inter" | "mynerve";

export interface StickyNote {
	id: number;
	/** Page-space top-left (canvas units at zoom 1). */
	x: number;
	y: number;
	color: NoteColor;
	fontSize: NoteFontSize;
	font: NoteFont;
	/** true = short strip, false = tall square note. */
	compact: boolean;
	/**
	 * Explicit size in SCREEN px, or null to follow the responsive default.
	 * The note draws at screen size, so a resize drag maps 1:1 to these.
	 */
	w: number | null;
	h: number | null;
	/** Plain text of the note (derived from the DOM). */
	text: string;
	/** Formatted content (sanitized HTML: b/i/u/s, ordered lists…). */
	html: string;
}

export interface StickyNotesOptions {
	host: HTMLElement;
	getZoom: () => number;
	storageKey?: string | null;
	defaultColor?: NoteColor;
	onChange?: (notes: StickyNotes) => void;
}

/**
 * Sticky geometry. Notes are viewport-constant chrome (see the counter-scale
 * in `place`), so a flat 260px square ate half the width of a narrow pane.
 * The cap only bites below ~800px; on a monitor the note stays 240, which is
 * FigJam's own sticky edge.
 */
const NOTE_MAX = 240;
const NOTE_VW = 0.3;
const NOTE_COMPACT_RATIO = 0.43;
/** Resize clamps. The floor is a bar plus one readable word. */
const NOTE_MIN = 96;
const NOTE_LIMIT = 1200;

/**
 * The rendered sticky edge in *screen* px. Mirrors the CSS `min()` below --
 * both derive from NOTE_MAX/NOTE_VW so they cannot drift apart, and
 * `page-notes.test.ts` pins that agreement.
 */
export function noteSize(viewportWidth: number = window.innerWidth): number {
	return Math.min(NOTE_MAX, viewportWidth * NOTE_VW);
}

const clampSize = (n: number) =>
	Math.max(NOTE_MIN, Math.min(NOTE_LIMIT, Math.round(n)));

/** A stored dimension, clamped, or null for "follow the responsive default". */
export function sizeOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? clampSize(v) : null;
}

/**
 * Push a note's size onto its element. Removing the custom property lets the
 * CSS `var(--sn-w, var(--sn-size))` fall back to the responsive default, so
 * "reset to default" needs no second code path.
 */
function applyNoteSize(el: HTMLElement, note: StickyNote): void {
	for (const [prop, v] of [
		["--sn-w", note.w],
		["--sn-h", note.h],
	] as const) {
		if (v === null) el.style.removeProperty(prop);
		else el.style.setProperty(prop, `${v}px`);
	}
}

/**
 * Top-left, in PAGE units, that puts a fresh note's middle on a page point.
 * Half a note is half a *screen* note, so it has to be divided back out of
 * the zoom -- without that the note only lands centred at 100% zoom and hangs
 * off the edge everywhere else.
 */
export function noteSpawnTopLeft(
	centre: { x: number; y: number },
	zoom: number,
	viewportWidth?: number,
): { x: number; y: number } {
	const half = noteSize(viewportWidth) / 2 / zoom;
	return { x: centre.x - half, y: centre.y - half };
}
const BAR_H = 18;
/**
 * Headroom (toolbar + tallest popover) needed above a note for the toolbar
 * to sit on top; with less, toolbar and trays flip below the note so the
 * trays never render off-screen.
 */
const FLIP_CLEAR = 190;
/**
 * Widest the dark toolbar gets (color + size + font + height). On a narrow
 * pane it is wider than the sticky itself, so anchoring it to the note's left
 * edge pushes its trays off-screen near the right edge.
 */
const TOOLBAR_CLEAR = 240;

/**
 * Where the toolbar can sit, given the note's rect **in screen px**. Both
 * axes flip the anchor rather than nudging by a measured overhang, so the
 * toolbar and its trays travel together and never need a second layout read.
 */
export function toolbarPlacement(
	box: { top: number; left: number },
	viewportWidth: number,
): { flip: boolean; anchorRight: boolean } {
	return {
		flip: box.top < FLIP_CLEAR,
		anchorRight: box.left + TOOLBAR_CLEAR > viewportWidth,
	};
}

/** paper color, text color — Mac-Stickies flat pastels */
const COLORS: Record<NoteColor, [string, string]> = {
	yellow: ["#f2c94c", "#211b06"],
	orange: ["#f39a5e", "#26130a"],
	green: ["#79c968", "#0d1f0a"],
	blue: ["#6ea3f2", "#0a1526"],
	purple: ["#b899ee", "#170d26"],
	pink: ["#ef7fb8", "#260d1b"],
	white: ["#ffffff", "#1c1c1c"],
	black: ["#2e2e2e", "#ededed"],
};

const FONT_SIZES: Record<NoteFontSize, number> = {
	small: 12,
	medium: 14,
	large: 18,
	huge: 24,
};

const SIZE_LABELS: Record<NoteFontSize, string> = {
	small: "Small",
	medium: "Medium",
	large: "Large",
	huge: "Huge",
};

const FONT_LABELS: Record<NoteFont, string> = {
	inter: "Inter",
	mynerve: "Mynerve",
};

/** Ctrl/Cmd + key → execCommand name. All four are toggles. */
const FORMAT_KEYS: Record<string, string> = {
	b: "bold",
	i: "italic",
	u: "underline",
	s: "strikeThrough",
};

const CHEVRON = `<svg class="sn-chev" width="8" height="6" viewBox="0 0 8 6" fill="none" aria-hidden="true"><path d="M1 1.5l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const HEIGHT_ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 1.5h10M2 12.5h10M7 4v6M5 5.8L7 4l2 1.8M5 8.2L7 10l2-1.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHECK = `<svg class="sn-checkmark" width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true"><path d="M1 4l2.6 2.6L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function buildCss(fonts: { woff2: string; woff: string }): string {
	const colorRules = (Object.keys(COLORS) as NoteColor[])
		.map((c) => {
			const [bg, text] = COLORS[c];
			return `.sn-note[data-color="${c}"]{background:${bg};color:${text}}`;
		})
		.join("\n");
	return `
@font-face{font-family:"Mynerve";src:url("${fonts.woff2}") format("woff2"),url("${fonts.woff}") format("woff");font-display:swap}
.sn-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;font-family:Inter,system-ui,-apple-system,sans-serif}
.sn-note{position:absolute;top:0;left:0;transform-origin:0 0;--sn-size:min(${NOTE_MAX}px,${NOTE_VW * 100}vw);width:var(--sn-w,var(--sn-size));height:var(--sn-h,var(--sn-size));pointer-events:auto;display:flex;flex-direction:column;box-shadow:0 10px 30px rgba(0,0,0,.28),0 2px 6px rgba(0,0,0,.16);border-radius:2px}
.sn-note[data-compact]{height:calc(var(--sn-h,var(--sn-size)) * ${NOTE_COMPACT_RATIO})}
.sn-note[data-selected]{outline:2px solid #7b61ff;outline-offset:0}
.sn-handle{position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;background:#fff;border:1px solid #7b61ff;border-radius:2px;display:none;cursor:nwse-resize;touch-action:none;z-index:2}
.sn-note[data-selected]:not([data-compact]) .sn-handle{display:block}
.sn-bar{height:${BAR_H}px;flex:none;cursor:grab;background:rgba(0,0,0,.09);display:flex;align-items:center;padding:0 5px;touch-action:none;border-radius:2px 2px 0 0}
.sn-bar:active{cursor:grabbing}
.sn-note[data-color="black"] .sn-bar{background:rgba(255,255,255,.08)}
.sn-close{width:8px;height:8px;flex:none;border:none;padding:0;background:rgba(0,0,0,.22);cursor:pointer}
.sn-close:hover{background:rgba(0,0,0,.45)}
.sn-note[data-color="black"] .sn-close{background:rgba(255,255,255,.28)}
.sn-note[data-color="black"] .sn-close:hover{background:rgba(255,255,255,.5)}
.sn-text{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:gray transparent;background:transparent;border:none;outline:none;padding:6px 4px;margin:2px 8px 10px;color:inherit;font-family:inherit;font-size:var(--sn-fs,14px);line-height:1.4;white-space:pre-wrap;word-break:break-word;cursor:text}
.sn-text[data-empty]::before{content:"Write note ...";opacity:.35;pointer-events:none}
.sn-text ol,.sn-text ul{margin:.15em 0;padding-left:1.5em}
.sn-text ol{list-style:decimal}
.sn-text ul{list-style:disc}
.sn-text,.sn-text *{font-synthesis:weight style}
.sn-text i,.sn-text em{font-style:italic}
.sn-text b,.sn-text strong{font-weight:700}
.sn-text u{text-decoration:underline}
.sn-text s,.sn-text strike,.sn-text del{text-decoration:line-through}
.sn-note[data-font="mynerve"] .sn-text{font-family:"Mynerve","Comic Sans MS",cursive}
${colorRules}
.sn-toolbar{position:absolute;left:0;top:-44px;height:36px;display:none;align-items:center;gap:2px;background:#1f1f1f;border-radius:8px;padding:0 4px;box-shadow:0 6px 20px rgba(0,0,0,.4);color:#e6e6e6;cursor:default;white-space:nowrap}
.sn-note[data-selected] .sn-toolbar{display:flex}
.sn-note[data-flip] .sn-toolbar{top:auto;bottom:-44px}
.sn-note[data-tb-right] .sn-toolbar{left:auto;right:0}
.sn-note[data-tb-right] .sn-pop{left:auto;right:0}
.sn-group{position:relative;display:flex}
.sn-tool{display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:none;background:transparent;border-radius:6px;color:inherit;font:500 12px/1 Inter,system-ui,-apple-system,sans-serif;cursor:pointer}
.sn-tool:hover{background:rgba(255,255,255,.08)}
.sn-tool[data-active]{background:#7b61ff;color:#fff}
.sn-dot{width:14px;height:14px;border-radius:50%;border:1px solid rgba(255,255,255,.25);flex:none}
.sn-chev{opacity:.55}
.sn-pop{position:absolute;bottom:calc(100% + 6px);left:0;display:none;background:#1f1f1f;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45);padding:8px;z-index:1}
.sn-note[data-flip] .sn-pop{bottom:auto;top:calc(100% + 6px)}
.sn-palette{grid-template-columns:repeat(4,auto);gap:8px}
.sn-palette[data-open]{display:grid}
.sn-menu{min-width:118px;padding:4px}
.sn-menu[data-open]{display:block}
.sn-swatch{width:22px;height:22px;border-radius:50%;border:1px solid rgba(255,255,255,.15);padding:0;cursor:pointer}
.sn-swatch[data-active]{box-shadow:0 0 0 2px #1f1f1f,0 0 0 4px #4c9ffe}
.sn-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:none;background:none;color:#e6e6e6;font:400 12px/1.2 Inter,system-ui,-apple-system,sans-serif;border-radius:6px;cursor:pointer;text-align:left}
.sn-item:hover{background:rgba(255,255,255,.08)}
.sn-item .sn-checkmark{visibility:hidden}
.sn-item[data-active] .sn-checkmark{visibility:visible}
`;
}

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles(css: string) {
	if (styleRefs++ === 0) {
		// drop stale sheets left behind by hot module replacement
		for (const el of document.querySelectorAll("style[data-sticky-note]"))
			el.remove();
		styleEl = document.createElement("style");
		styleEl.dataset.stickyNote = "";
		styleEl.textContent = css;
		document.head.appendChild(styleEl);
	}
}

function releaseStyles() {
	if (--styleRefs === 0) {
		styleEl?.remove();
		styleEl = null;
	}
}

function isTypingTarget(t: EventTarget | null): boolean {
	if (!(t instanceof HTMLElement)) return false;
	// hasAttribute covers engines (and jsdom) where isContentEditable lies
	if (t.isContentEditable || t.hasAttribute("contenteditable")) return true;
	const tag = t.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Whitelist sanitizer for note content. Only formatting produced by the
 * editor survives (bold/italic/underline/strike, lists, line structure);
 * every attribute is stripped, script/style are dropped, everything else is
 * unwrapped. Applied to pasted HTML and to anything read from storage —
 * the editor's own output is already inside the whitelist.
 */
const ALLOWED_TAGS = new Set([
	"B",
	"STRONG",
	"I",
	"EM",
	"U",
	"S",
	"STRIKE",
	"DEL",
	"OL",
	"UL",
	"LI",
	"BR",
	"DIV",
	"P",
]);

function sanitizeHtml(html: string): string {
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	const walk = (node: Node) => {
		for (const child of [...node.childNodes]) {
			if (child.nodeType === Node.TEXT_NODE) continue;
			if (!(child instanceof Element)) {
				child.remove();
				continue;
			}
			if (child.tagName === "SCRIPT" || child.tagName === "STYLE") {
				child.remove();
				continue;
			}
			walk(child);
			if (ALLOWED_TAGS.has(child.tagName)) {
				for (const attr of [...child.attributes])
					child.removeAttribute(attr.name);
			} else {
				child.replaceWith(...child.childNodes);
			}
		}
	};
	walk(tpl.content);
	return tpl.innerHTML;
}

const escapeText = (t: string) =>
	t.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
	);

const textToHtml = (t: string) => t.split("\n").map(escapeText).join("<br>");

const isFont = (f: unknown): f is NoteFont => f === "inter" || f === "mynerve";

interface NoteRefs {
	el: HTMLDivElement;
	text: HTMLDivElement;
	dot: HTMLSpanElement;
	sizeLabel: HTMLSpanElement;
	fontLabel: HTMLSpanElement;
	heightBtn: HTMLButtonElement;
	swatches: Map<NoteColor, HTMLButtonElement>;
	sizeItems: Map<NoteFontSize, HTMLButtonElement>;
	fontItems: Map<NoteFont, HTMLButtonElement>;
}

export class StickyNotes {
	readonly supported =
		typeof window !== "undefined" && typeof document !== "undefined";

	private storageKey: string | null;
	private defaultColor: NoteColor;
	private onChange: StickyNotesOptions["onChange"];
	private getZoom: () => number;

	private root!: HTMLDivElement;
	private refs = new Map<number, NoteRefs>();
	private notes: StickyNote[] = [];
	private nextId = 1;
	private selectedId: number | null = null;
	private openPop: HTMLElement | null = null;
	private _hidden = false;
	private zTop = 1;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private prevCursor = "";

	constructor(options: StickyNotesOptions) {
		this.storageKey =
			options.storageKey === undefined
				? "interaction-lab:notes:v1"
				: options.storageKey;
		this.defaultColor = options.defaultColor ?? "yellow";
		this.onChange = options.onChange;
		this.getZoom = options.getZoom;
		if (!this.supported) return;
		acquireStyles(
			buildCss({
				woff2: MYNERVE_WOFF2,
				woff: MYNERVE_WOFF,
			}),
		);
		this.root = document.createElement("div");
		this.root.className = "sn-root";
		options.host.appendChild(this.root);
		this.loadNotes();
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
	}

	getNotes(): readonly StickyNote[] {
		return this.notes.map((n) => ({ ...n }));
	}

	get hidden() {
		return this._hidden;
	}

	/** Hide/show every note without deleting anything (Ctrl+Shift+N). */
	/** Are all notes hidden? Chrome that shows tool state has to read it. */
	isHidden(): boolean {
		return this.hidden;
	}

	setHidden(hidden: boolean) {
		if (!this.supported || this._hidden === hidden) return;
		this._hidden = hidden;
		this.root.style.display = hidden ? "none" : "block";
		if (hidden) {
			this.closePop();
			this.select(null);
		}
		this.onChange?.(this);
	}

	/** Spawn a note at page coordinates and focus it. */
	spawn(init: Partial<Omit<StickyNote, "id">> = {}): StickyNote {
		const step = (this.notes.length % 6) * 24;
		const note: StickyNote = {
			id: this.nextId++,
			x: init.x ?? step,
			y: init.y ?? step,
			color: init.color ?? this.defaultColor,
			fontSize: init.fontSize ?? "medium",
			font: init.font ?? "inter",
			compact: init.compact ?? false,
			w: sizeOrNull(init.w),
			h: sizeOrNull(init.h),
			text: "",
			html:
				init.html !== undefined
					? sanitizeHtml(init.html)
					: textToHtml(init.text ?? ""),
		};
		this.notes.push(note);
		this.mountNote(note);
		this.select(note.id);
		this.enterEdit(note.id);
		this.commit();
		return { ...note };
	}

	removeNote(id: number) {
		const i = this.notes.findIndex((n) => n.id === id);
		if (i === -1) return;
		this.notes.splice(i, 1);
		this.refs.get(id)?.el.remove();
		this.refs.delete(id);
		if (this.selectedId === id) this.selectedId = null;
		this.commit();
	}

	clearNotes() {
		for (const r of this.refs.values()) r.el.remove();
		this.refs.clear();
		this.notes = [];
		this.selectedId = null;
		this.commit();
	}

	setColor(id: number, color: NoteColor) {
		const note = this.notes.find((n) => n.id === id);
		const r = this.refs.get(id);
		if (!note || !r) return;
		note.color = color;
		r.el.dataset.color = color;
		r.dot.style.background = COLORS[color][0];
		for (const [c, b] of r.swatches)
			b.toggleAttribute("data-active", c === color);
		this.commit();
	}

	setFontSize(id: number, fontSize: NoteFontSize) {
		const note = this.notes.find((n) => n.id === id);
		const r = this.refs.get(id);
		if (!note || !r) return;
		note.fontSize = fontSize;
		r.el.style.setProperty("--sn-fs", `${FONT_SIZES[fontSize]}px`);
		r.sizeLabel.textContent = SIZE_LABELS[fontSize];
		for (const [s, b] of r.sizeItems)
			b.toggleAttribute("data-active", s === fontSize);
		this.commit();
	}

	setFont(id: number, font: NoteFont) {
		const note = this.notes.find((n) => n.id === id);
		const r = this.refs.get(id);
		if (!note || !r) return;
		note.font = font;
		r.el.dataset.font = font;
		r.fontLabel.textContent = FONT_LABELS[font];
		for (const [f, b] of r.fontItems)
			b.toggleAttribute("data-active", f === font);
		this.commit();
	}

	setCompact(id: number, compact: boolean) {
		const note = this.notes.find((n) => n.id === id);
		const r = this.refs.get(id);
		if (!note || !r) return;
		note.compact = compact;
		r.el.toggleAttribute("data-compact", compact);
		r.heightBtn.toggleAttribute("data-active", compact);
		this.commit();
	}

	destroy() {
		if (!this.supported) return;
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		clearTimeout(this.saveTimer);
		this.root.remove();
		releaseStyles();
	}

	// ------------------------------------------------------------------ dom

	private mountNote(note: StickyNote) {
		const el = document.createElement("div");
		el.className = "sn-note";
		// zoom with the cursor over a sticky pivots on the sticky, not the cursor
		el.setAttribute("data-zoom-anchor", "");
		el.dataset.color = note.color;
		el.dataset.font = note.font;
		el.toggleAttribute("data-compact", note.compact);
		el.style.setProperty("--sn-fs", `${FONT_SIZES[note.fontSize]}px`);
		el.style.zIndex = String(++this.zTop);
		el.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			this.select(note.id);
			el.style.zIndex = String(++this.zTop);
		});

		// header strip: drag handle + close box (Mac Stickies)
		const bar = document.createElement("div");
		bar.className = "sn-bar";
		const close = document.createElement("button");
		close.className = "sn-close";
		close.type = "button";
		close.setAttribute("aria-label", "Delete note");
		close.addEventListener("pointerdown", (e) => e.stopPropagation());
		close.addEventListener("click", () => this.removeNote(note.id));
		bar.appendChild(close);
		bar.addEventListener("pointerdown", (e) => {
			if (e.button === 0 && e.target !== close) this.beginDrag(e, note);
		});

		// rich text editor: a contenteditable div (a textarea can't hold
		// bold/italic runs or lists)
		const text = document.createElement("div");
		text.className = "sn-text";
		text.setAttribute("contenteditable", "true");
		text.tabIndex = -1; // programmatically focusable everywhere
		text.innerHTML = note.html;
		note.text = text.textContent ?? "";
		text.toggleAttribute("data-empty", text.textContent === "");
		text.addEventListener("input", (e) => {
			// strikethrough is per-line by design: a fresh line never inherits
			// it (bold/italic/underline continue normally, like every editor)
			const inputType = (e as InputEvent).inputType;
			if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
				try {
					if (document.queryCommandState("strikeThrough"))
						document.execCommand("strikeThrough");
				} catch {
					// environments without editing APIs (jsdom)
				}
			}
			this.syncText(note, text);
		});
		text.addEventListener("keydown", (e) => {
			if (e.key === " ") this.maybeStartList(e, note, text);
			else if (e.key === "Enter") this.maybeExitList(e, note, text);
		});
		text.addEventListener("paste", (e) => {
			e.preventDefault();
			const dt = e.clipboardData;
			if (!dt) return;
			const html = dt.getData("text/html");
			const safe = html
				? sanitizeHtml(html)
				: textToHtml(dt.getData("text/plain"));
			try {
				document.execCommand("insertHTML", false, safe);
			} catch {
				// very old engines: fall back to plain text
				try {
					document.execCommand("insertText", false, dt.getData("text/plain"));
				} catch {
					// give up quietly — the paste is dropped, nothing breaks
				}
			}
			this.syncText(note, text);
		});
		text.addEventListener("blur", () => {
			// normalize the <br> Chrome leaves behind in emptied contenteditables
			if ((text.textContent ?? "") === "" && text.innerHTML !== "") {
				text.innerHTML = "";
				this.syncText(note, text);
			}
		});
		// NOTE: trays are closed by pointerdown routing (onDocPointerDown), never
		// by focus events — window activation replays focus/blur on the editor
		// and would close a tray the moment the browser regains focus.

		const {
			toolbar,
			dot,
			sizeLabel,
			fontLabel,
			heightBtn,
			swatches,
			sizeItems,
			fontItems,
		} = this.buildToolbar(note);

		applyNoteSize(el, note);

		// bottom-right resize grip, same idiom as a label's scale handle
		const handle = document.createElement("div");
		handle.className = "sn-handle";
		handle.setAttribute("aria-label", "Resize note");
		handle.addEventListener("pointerdown", (e) => this.beginResize(e, note));
		// a double-tap on the grip hands the note back to the default size
		handle.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			this.resetSize(note.id);
		});

		el.append(bar, text, toolbar, handle);
		this.root.appendChild(el);
		this.refs.set(note.id, {
			el,
			text,
			dot,
			sizeLabel,
			fontLabel,
			heightBtn,
			swatches,
			sizeItems,
			fontItems,
		});
		this.positionEl(note);
	}

	/** Figma-plugin-style dark toolbar: color, text size, font, height. */
	private buildToolbar(note: StickyNote) {
		const toolbar = document.createElement("div");
		toolbar.className = "sn-toolbar";
		toolbar.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			// keep focus in the editor while using the toolbar (Figma-style):
			// no blur/refocus dance, so writing continues after picking a color
			e.preventDefault();
		});

		// color swatch + palette popover
		const colorGroup = document.createElement("div");
		colorGroup.className = "sn-group";
		const colorBtn = document.createElement("button");
		colorBtn.className = "sn-tool";
		colorBtn.type = "button";
		colorBtn.setAttribute("aria-label", "Note color");
		const dot = document.createElement("span");
		dot.className = "sn-dot";
		dot.style.background = COLORS[note.color][0];
		colorBtn.appendChild(dot);
		colorBtn.insertAdjacentHTML("beforeend", CHEVRON);
		const palette = document.createElement("div");
		palette.className = "sn-pop sn-palette";
		const swatches = new Map<NoteColor, HTMLButtonElement>();
		for (const c of Object.keys(COLORS) as NoteColor[]) {
			const b = document.createElement("button");
			b.className = "sn-swatch";
			b.type = "button";
			b.style.background = COLORS[c][0];
			b.setAttribute("aria-label", c);
			b.toggleAttribute("data-active", c === note.color);
			b.addEventListener("click", () => {
				this.setColor(note.id, c);
				this.closePop();
			});
			palette.appendChild(b);
			swatches.set(c, b);
		}
		colorBtn.addEventListener("click", () => this.togglePop(palette));
		colorGroup.append(colorBtn, palette);

		// generic dropdown builder for the size + font menus
		const buildMenu = <K extends string>(
			ariaLabel: string,
			entries: [K, string][],
			active: K,
			onPick: (key: K) => void,
		) => {
			const group = document.createElement("div");
			group.className = "sn-group";
			const btn = document.createElement("button");
			btn.className = "sn-tool";
			btn.type = "button";
			btn.setAttribute("aria-label", ariaLabel);
			const label = document.createElement("span");
			label.textContent =
				entries.find(([k]) => k === active)?.[1] ?? entries[0][1];
			btn.appendChild(label);
			btn.insertAdjacentHTML("beforeend", CHEVRON);
			const menu = document.createElement("div");
			menu.className = "sn-pop sn-menu";
			const items = new Map<K, HTMLButtonElement>();
			for (const [key, name] of entries) {
				const b = document.createElement("button");
				b.className = "sn-item";
				b.type = "button";
				b.insertAdjacentHTML("beforeend", CHECK);
				b.insertAdjacentText("beforeend", name);
				b.toggleAttribute("data-active", key === active);
				b.addEventListener("click", () => {
					onPick(key);
					this.closePop();
				});
				menu.appendChild(b);
				items.set(key, b);
			}
			btn.addEventListener("click", () => this.togglePop(menu));
			group.append(btn, menu);
			return { group, label, items };
		};

		const size = buildMenu<NoteFontSize>(
			"Text size",
			(Object.keys(FONT_SIZES) as NoteFontSize[]).map((s) => [
				s,
				SIZE_LABELS[s],
			]),
			note.fontSize,
			(s) => this.setFontSize(note.id, s),
		);

		const font = buildMenu<NoteFont>(
			"Font",
			(Object.keys(FONT_LABELS) as NoteFont[]).map((f) => [f, FONT_LABELS[f]]),
			note.font,
			(f) => this.setFont(note.id, f),
		);

		// compact / tall toggle
		const heightBtn = document.createElement("button");
		heightBtn.className = "sn-tool";
		heightBtn.type = "button";
		heightBtn.setAttribute("aria-label", "Toggle note height");
		heightBtn.innerHTML = HEIGHT_ICON;
		heightBtn.toggleAttribute("data-active", note.compact);
		heightBtn.addEventListener("click", () =>
			this.setCompact(
				note.id,
				!this.notes.find((n) => n.id === note.id)?.compact,
			),
		);

		toolbar.append(colorGroup, size.group, font.group, heightBtn);
		return {
			toolbar,
			dot,
			sizeLabel: size.label,
			fontLabel: font.label,
			heightBtn,
			swatches,
			sizeItems: size.items,
			fontItems: font.items,
		};
	}

	private positionEl(note: StickyNote) {
		const r = this.refs.get(note.id);
		if (!r) return;
		// Page-unit position, screen-size drawing — see the note in styles().
		r.el.style.transform = `translate3d(${note.x}px,${note.y}px,0) scale(var(--inv-zoom,1))`;
		if (this.selectedId === note.id) this.placeToolbar(note.id);
	}

	/**
	 * Park the toolbar somewhere it fits. `note.y` is a PAGE coordinate, so it
	 * cannot be compared to a screen-px clearance — the rect is the only
	 * honest source. Only the selected note has a visible toolbar, so this
	 * costs at most one layout read per frame.
	 */
	private placeToolbar(id: number) {
		const r = this.refs.get(id);
		if (!r) return;
		const box = r.el.getBoundingClientRect();
		const at = toolbarPlacement(box, window.innerWidth);
		// Only touch attributes on actual change — this runs per drag frame.
		if (r.el.hasAttribute("data-flip") !== at.flip)
			r.el.toggleAttribute("data-flip", at.flip);
		if (r.el.hasAttribute("data-tb-right") !== at.anchorRight)
			r.el.toggleAttribute("data-tb-right", at.anchorRight);
	}

	private enterEdit(id: number) {
		const r = this.refs.get(id);
		if (!r) return;
		r.text.focus();
		const range = document.createRange();
		range.selectNodeContents(r.text);
		range.collapse(false);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);
	}

	// ------------------------------------------------------------- editing

	private syncText(note: StickyNote, text: HTMLDivElement) {
		note.html = text.innerHTML;
		note.text = text.textContent ?? "";
		const empty = note.text === "" && !text.querySelector("li");
		if (text.hasAttribute("data-empty") !== empty)
			text.toggleAttribute("data-empty", empty);
		this.commit();
	}

	/**
	 * Autoformat: a space typed right after "1." at the start of a line turns
	 * the line into a numbered list. Enter then continues 2., 3., … natively.
	 * The list is built by hand — Chrome's `insertOrderedList` merges
	 * neighboring blocks into the new list, eating the line above.
	 */
	private maybeStartList(
		e: KeyboardEvent,
		note: StickyNote,
		text: HTMLDivElement,
	) {
		const sel = window.getSelection();
		if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return;
		const node = sel.anchorNode;
		if (!node || node.nodeType !== Node.TEXT_NODE) return;
		const content = node.textContent ?? "";
		if (content.slice(0, sel.anchorOffset) !== "1.") return;
		if (node.previousSibling) return; // "1." must start its line
		if (!text.contains(node)) return;
		if (node.parentElement?.closest("li")) return; // already in a list
		e.preventDefault();

		const rest = content.slice(sel.anchorOffset);
		const ol = document.createElement("ol");
		const li = document.createElement("li");
		ol.appendChild(li);
		const line = node.parentElement === text ? null : node.parentElement;
		if (line) {
			// move the whole line (minus the "1." prefix) into the item,
			// keeping any inline formatting it already had
			node.textContent = rest;
			while (line.firstChild) li.appendChild(line.firstChild);
			line.replaceWith(ol);
		} else {
			// bare text node sitting directly in the editor root
			text.replaceChild(ol, node);
			if (rest) {
				node.textContent = rest;
				li.appendChild(node);
			}
		}
		if (!li.firstChild) li.appendChild(document.createElement("br"));
		const range = document.createRange();
		range.selectNodeContents(li);
		range.collapse(true);
		sel.removeAllRanges();
		sel.addRange(range);
		this.syncText(note, text);
	}

	/**
	 * Enter on an empty list item leaves the list (Chrome doesn't do this
	 * reliably on its own): toggle the item out via the matching list command.
	 */
	private maybeExitList(
		e: KeyboardEvent,
		note: StickyNote,
		text: HTMLDivElement,
	) {
		const sel = window.getSelection();
		const anchor = sel?.anchorNode;
		if (!anchor) return;
		const from = anchor instanceof Element ? anchor : anchor.parentElement;
		const li = from?.closest("li");
		if (!li || !text.contains(li)) return;
		if ((li.textContent ?? "") !== "") return;
		e.preventDefault();
		this.exec(
			li.parentElement?.tagName === "UL"
				? "insertUnorderedList"
				: "insertOrderedList",
		);
		this.syncText(note, text);
	}

	/** execCommand with a jsdom-safe guard; formatting is undo-stack aware. */
	private exec(command: string) {
		try {
			document.execCommand(command);
		} catch {
			// environments without execCommand (jsdom) — formatting is a no-op
		}
	}

	// ----------------------------------------------------------- interaction

	private beginDrag(e: PointerEvent, note: StickyNote) {
		e.preventDefault();
		e.stopPropagation();
		// grabbing the bar leaves writing mode, so Delete acts on the note
		const active = document.activeElement;
		if (active instanceof HTMLElement && active.classList.contains("sn-text"))
			active.blur();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		this.closePop();
		const z0 = this.getZoom();
		const originX = e.clientX;
		const originY = e.clientY;
		const startPageX = note.x;
		const startPageY = note.y;
		this.prevCursor = document.documentElement.style.cursor;
		document.documentElement.style.cursor = "grabbing";

		const onMove = (ev: PointerEvent) => {
			const z = this.getZoom() || z0;
			note.x = startPageX + (ev.clientX - originX) / z;
			note.y = startPageY + (ev.clientY - originY) / z;
			this.positionEl(note);
		};
		const onEnd = () => {
			target.removeEventListener("pointermove", onMove);
			target.removeEventListener("pointerup", onEnd);
			target.removeEventListener("pointercancel", onEnd);
			document.documentElement.style.cursor = this.prevCursor;
			this.commit();
		};
		target.addEventListener("pointermove", onMove);
		target.addEventListener("pointerup", onEnd);
		target.addEventListener("pointercancel", onEnd);
	}

	handleKey(e: KeyboardEvent, spawnAt: () => { x: number; y: number }): boolean {
		if (e.key === "Escape") {
			this.closePop();
			const active = document.activeElement;
			if (
				active instanceof HTMLElement &&
				active.classList.contains("sn-text") &&
				this.root.contains(active)
			) {
				active.blur();
				return true;
			}
			if (this.selectedId != null) {
				this.select(null);
				return true;
			}
			return false;
		}
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
			const active = document.activeElement;
			if (
				active instanceof HTMLElement &&
				active.classList.contains("sn-text") &&
				this.root.contains(active)
			) {
				const command = FORMAT_KEYS[e.key.toLowerCase()];
				if (command) {
					e.preventDefault();
					this.exec(command);
					const note = this.notes.find(
						(n) => this.refs.get(n.id)?.text === active,
					);
					if (note) this.syncText(note, active as HTMLDivElement);
					return true;
				}
			}
		}
		const isN = e.code === "KeyN" || e.key.toLowerCase() === "n";
		if (isN && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.setHidden(!this._hidden);
			return true;
		}
		if (isTypingTarget(e.target)) return false;
		if (isN && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.setHidden(false);
			const at = spawnAt();
			this.spawn({ x: at.x, y: at.y });
			return true;
		}
		if (this._hidden) return false;
		if (
			(e.key === "Delete" || e.key === "Backspace") &&
			this.selectedId != null
		) {
			e.preventDefault();
			this.removeNote(this.selectedId);
			return true;
		}
		return false;
	}

	private onDocPointerDown = (e: PointerEvent) => {
		if (e.target instanceof Node && this.root.contains(e.target)) {
			// clicking inside a different part of the overlay still closes any
			// open popover that the click wasn't within
			if (this.openPop && !this.openPop.parentElement?.contains(e.target))
				this.closePop();
			return;
		}
		this.closePop();
		this.select(null);
	};

	/** Explicit size in SCREEN px. The note draws at screen size, so a resize
	 * drag maps 1:1 to these; both axes are free, like Mac Stickies. */
	setSize(id: number, w: number, h: number) {
		const note = this.notes.find((n) => n.id === id);
		if (!note) return;
		const nw = clampSize(w);
		const nh = clampSize(h);
		if (note.w === nw && note.h === nh) return;
		note.w = nw;
		note.h = nh;
		const r = this.refs.get(id);
		if (r) applyNoteSize(r.el, note);
		this.commit();
	}

	/** Hand the note back to the responsive default size. */
	resetSize(id: number) {
		const note = this.notes.find((n) => n.id === id);
		if (!note || (note.w === null && note.h === null)) return;
		note.w = null;
		note.h = null;
		const r = this.refs.get(id);
		if (r) applyNoteSize(r.el, note);
		this.commit();
	}

	private beginResize(e: PointerEvent, note: StickyNote) {
		e.preventDefault();
		e.stopPropagation();
		this.select(note.id);
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		const r = this.refs.get(note.id);
		if (!r) return;
		// Net scale through the counter-scaled layer is 1, so the element's own
		// box is already in screen px and the pointer delta needs no conversion.
		const box = r.el.getBoundingClientRect();
		const startW = box.width;
		const startH = box.height;
		const sx = e.clientX;
		const sy = e.clientY;
		this.prevCursor = document.documentElement.style.cursor;
		document.documentElement.style.cursor = "nwse-resize";

		const onMove = (ev: PointerEvent) => {
			this.setSize(note.id, startW + (ev.clientX - sx), startH + (ev.clientY - sy));
		};
		const onEnd = () => {
			target.removeEventListener("pointermove", onMove);
			target.removeEventListener("pointerup", onEnd);
			target.removeEventListener("pointercancel", onEnd);
			document.documentElement.style.cursor = this.prevCursor;
		};
		target.addEventListener("pointermove", onMove);
		target.addEventListener("pointerup", onEnd);
		target.addEventListener("pointercancel", onEnd);
	}

	private select(id: number | null) {
		if (this.selectedId === id) return;
		if (this.selectedId !== null) this.closePop();
		this.selectedId = id;
		for (const [nid, r] of this.refs)
			r.el.toggleAttribute("data-selected", nid === id);
		if (id !== null) this.placeToolbar(id);
	}

	private togglePop(pop: HTMLElement) {
		if (this.openPop === pop) {
			this.closePop();
			return;
		}
		this.closePop();
		pop.toggleAttribute("data-open", true);
		this.openPop = pop;
	}

	private closePop() {
		this.openPop?.removeAttribute("data-open");
		this.openPop = null;
	}

	// -------------------------------------------------------------- persist

	private commit() {
		if (this.storageKey) {
			clearTimeout(this.saveTimer);
			this.saveTimer = setTimeout(() => {
				try {
					localStorage.setItem(
						this.storageKey as string,
						JSON.stringify({
							v: 1,
							notes: this.notes.map((n) => ({
								x: n.x,
								y: n.y,
								c: n.color,
								f: n.fontSize,
								ff: n.font,
								k: n.compact,
								w: n.w,
								hh: n.h,
								t: n.text,
								h: sanitizeHtml(n.html),
							})),
						}),
					);
				} catch {
					// storage unavailable — notes stay in-memory
				}
			}, 150);
		}
		this.onChange?.(this);
	}

	private loadNotes() {
		if (!this.storageKey) return;
		try {
			const raw = localStorage.getItem(this.storageKey);
			if (!raw) return;
			const data = JSON.parse(raw) as {
				v: number;
				notes: {
					x: number;
					y: number;
					c: NoteColor;
					f: NoteFontSize;
					ff?: unknown;
					k: boolean;
					w?: unknown;
					hh?: unknown;
					t: string;
					h?: unknown;
				}[];
			};
			if (data.v !== 1 || !Array.isArray(data.notes)) return;
			for (const n of data.notes) {
				if (typeof n.x !== "number" || typeof n.y !== "number") continue;
				const note: StickyNote = {
					id: this.nextId++,
					x: n.x,
					y: n.y,
					color: n.c in COLORS ? n.c : this.defaultColor,
					fontSize: n.f in FONT_SIZES ? n.f : "medium",
					font: isFont(n.ff) ? n.ff : "inter",
					compact: Boolean(n.k),
					w: sizeOrNull(n.w),
					h: sizeOrNull(n.hh),
					text: "",
					html:
						typeof n.h === "string"
							? sanitizeHtml(n.h)
							: textToHtml(typeof n.t === "string" ? n.t : ""),
				};
				this.notes.push(note);
				this.mountNote(note); // derives note.text from the mounted DOM
			}
		} catch {
			// corrupt payload — start with no notes
		}
	}
}
