/**
 * Page-space handwritten labels for the Interaction Lab.
 *
 * Reference UX (viewport labels): github.com/timothymaarv/label-maker @ 82df5ba —
 * no LICENSE file; read for mechanism, do not vendor.
 * Positions are page units and live inside the camera-transformed layer, so
 * arrows pan/zoom with canvas content (Shift+L spawns at the viewport-center
 * page point).
 *
 * Mynerve: Google Fonts, SIL Open Font License 1.1.
 */

const MYNERVE_WOFF2 = "/fonts/mynerve/regular.woff2";
const MYNERVE_WOFF = "/fonts/mynerve/regular.woff";

/** Which quadrant the arrow points into, relative to the text. */
export type LabelDirection = "dr" | "dl" | "ur" | "ul";

export interface LabelItem {
	id: number;
	/** Page-space top-left (canvas units at zoom 1). */
	x: number;
	y: number;
	/** Uniform scale (0.4–4); applied via font-size, arrow follows in em. */
	scale: number;
	dir: LabelDirection;
	text: string;
}

export interface LabelsOptions {
	host: HTMLElement;
	getZoom: () => number;
	/**
	 * localStorage key used to persist labels across reloads.
	 * Pass `null` to disable persistence. Defaults to DEFAULT_LABELS_KEY.
	 */
	storageKey?: string | null;
	/** Ink color. Defaults to "#1c1c1c". */
	ink?: string;
	/** Called after any state change (spawn, edit, move, scale, delete…). */
	onChange?: (labels: Labels) => void;
}

export const DEFAULT_LABELS_KEY = "interaction-lab:labels:v1";

const BASE_FONT = 28; // px at scale 1
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
export const AIM_DEAD_ZONE = 14;

/**
 * One hand-drawn S-curve swoosh per direction, mirrored in place inside the
 * 100×60 viewBox (x → 100−x and/or y → 60−y). No transforms — each
 * direction is its own honest stroke, so layout and hit-testing stay true.
 */
const ARROWS: Record<LabelDirection, string> = {
	dr: "M6 8C28 32 60 14 89 41M91 43L73 39.5M91 43L84 25.5",
	dl: "M94 8C72 32 40 14 11 41M9 43L27 39.5M9 43L16 25.5",
	ur: "M6 52C28 28 60 46 89 19M91 17L73 20.5M91 17L84 34.5",
	ul: "M94 52C72 28 40 46 11 19M9 17L27 20.5M9 17L16 34.5",
};

/** Clockwise on screen: SE → SW → NW → NE. */
export const DIR_CYCLE: LabelDirection[] = ["dr", "dl", "ul", "ur"];

export const MIRROR: Record<LabelDirection, LabelDirection> = {
	dr: "dl",
	dl: "dr",
	ur: "ul",
	ul: "ur",
};

export function cycleDirection(
	dir: LabelDirection,
	reverse = false,
): LabelDirection {
	const i = DIR_CYCLE.indexOf(dir);
	const from = i === -1 ? 0 : i;
	return DIR_CYCLE[(from + (reverse ? 3 : 1)) % 4];
}

export function directionFromAim(
	dx: number,
	dy: number,
): LabelDirection | null {
	if (Math.hypot(dx, dy) < AIM_DEAD_ZONE) return null;
	return dy >= 0 ? (dx >= 0 ? "dr" : "dl") : dx >= 0 ? "ur" : "ul";
}

export function viewportDeltaToPage(
	dx: number,
	dy: number,
	zoom: number,
): { x: number; y: number } {
	const z = zoom || 1;
	return { x: dx / z, y: dy / z };
}

const ARROW = `<svg class="lb-arrow" viewBox="0 0 100 60" fill="none" aria-hidden="true"><path d="${ARROWS.dr}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function buildCss(fonts: { woff2: string; woff: string }) {
	return `
@font-face{font-family:"Mynerve";src:url("${fonts.woff2}") format("woff2"),url("${fonts.woff}") format("woff");font-display:swap}
.lb-root{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;font-family:"Mynerve","Comic Sans MS",cursive}
.lb-label{position:absolute;top:0;left:0;pointer-events:auto;display:flex;flex-direction:column;align-items:flex-start;padding:.2em .35em;font-family:"Mynerve","Comic Sans MS",cursive;line-height:1.15;cursor:grab;touch-action:none;user-select:none;color:var(--lb-ink)}
.lb-label:active{cursor:grabbing}
.lb-label[data-selected]{outline:1px solid #4c9ffe}
.lb-label[data-editing]{cursor:auto}
.lb-text{outline:none;white-space:pre-wrap;min-width:1.4em;min-height:1.15em}
.lb-label[data-editing] .lb-text{user-select:text;cursor:text}
.lb-text[data-empty]::before{content:"label me";opacity:.35}
.lb-arrowwrap{position:relative;align-self:flex-end;margin:.05em 0 0 1em}
.lb-label[data-dir="dl"] .lb-arrowwrap{align-self:flex-start;margin:.05em 1em 0 0}
.lb-label[data-dir="ur"] .lb-arrowwrap{order:-1;margin:0 0 .05em 1em}
.lb-label[data-dir="ul"] .lb-arrowwrap{order:-1;align-self:flex-start;margin:0 1em .05em 0}
.lb-arrow{display:block;width:3.6em;height:2.16em}
.lb-handle{position:absolute;right:-6px;bottom:-6px;width:10px;height:10px;background:#fff;border:1px solid #4c9ffe;border-radius:2px;display:none;cursor:nwse-resize;touch-action:none}
.lb-aim{position:absolute;right:-16px;top:50%;margin-top:-5px;width:10px;height:10px;background:#fff;border:1px solid #4c9ffe;border-radius:50%;display:none;cursor:crosshair;touch-action:none}
.lb-label[data-dir="dl"] .lb-aim,.lb-label[data-dir="ul"] .lb-aim{right:auto;left:-16px}
.lb-label[data-selected] .lb-handle,.lb-label[data-selected] .lb-aim{display:block}
`;
}

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles(css: string) {
	if (styleRefs++ === 0) {
		// drop stale sheets left behind by hot module replacement
		for (const el of document.querySelectorAll("style[data-label-overlay]"))
			el.remove();
		styleEl = document.createElement("style");
		styleEl.dataset.labelOverlay = "";
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

const clamp = (n: number, min: number, max: number) =>
	Math.min(Math.max(n, min), max);

const isDirection = (d: unknown): d is LabelDirection =>
	d === "dr" || d === "dl" || d === "ur" || d === "ul";

interface LabelRefs {
	el: HTMLDivElement;
	text: HTMLDivElement;
	path: SVGPathElement;
}

export class Labels {
	readonly supported =
		typeof window !== "undefined" && typeof document !== "undefined";

	private storageKey: string | null;
	private onChange: LabelsOptions["onChange"];
	private getZoom: () => number;

	private root!: HTMLDivElement;
	private refs = new Map<number, LabelRefs>();
	private items: LabelItem[] = [];
	private nextId = 1;
	private selectedId: number | null = null;
	private _hidden = false;
	private zTop = 1;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private prevCursor = "";

	constructor(options: LabelsOptions) {
		this.storageKey =
			options.storageKey === undefined
				? DEFAULT_LABELS_KEY
				: options.storageKey;
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
		this.root.className = "lb-root";
		this.root.style.setProperty("--lb-ink", options.ink ?? "#1c1c1c");
		options.host.appendChild(this.root);
		this.loadItems();
		document.addEventListener("pointerdown", this.onDocPointerDown, true);
	}

	getLabels(): readonly LabelItem[] {
		return this.items.map((l) => ({ ...l }));
	}

	get hidden() {
		return this._hidden;
	}

	/** Hide/show every label without deleting anything (Ctrl+Shift+L). */
	/** Are all labels hidden? Chrome that shows tool state has to read it. */
	isHidden(): boolean {
		return this.hidden;
	}

	setHidden(hidden: boolean) {
		if (!this.supported || this._hidden === hidden) return;
		this._hidden = hidden;
		this.root.style.display = hidden ? "none" : "block";
		if (hidden) this.select(null);
		this.onChange?.(this);
	}

	/** Spawn a label at page coordinates and focus it. */
	spawn(init: Partial<Omit<LabelItem, "id">> = {}): LabelItem {
		const step = (this.items.length % 6) * 22;
		const label: LabelItem = {
			id: this.nextId++,
			x: init.x ?? step,
			y: init.y ?? step,
			scale: clamp(init.scale ?? 1, MIN_SCALE, MAX_SCALE),
			dir: init.dir ?? "dr",
			text: init.text ?? "",
		};
		this.items.push(label);
		this.mountLabel(label);
		this.select(label.id);
		this.enterEdit(label.id);
		this.commit();
		return { ...label };
	}

	removeLabel(id: number) {
		const i = this.items.findIndex((l) => l.id === id);
		if (i === -1) return;
		this.items.splice(i, 1);
		this.refs.get(id)?.el.remove();
		this.refs.delete(id);
		if (this.selectedId === id) this.selectedId = null;
		this.commit();
	}

	clearLabels() {
		for (const r of this.refs.values()) r.el.remove();
		this.refs.clear();
		this.items = [];
		this.selectedId = null;
		this.commit();
	}

	setScale(id: number, scale: number) {
		const label = this.items.find((l) => l.id === id);
		const r = this.refs.get(id);
		if (!label || !r) return;
		const next = clamp(Math.round(scale * 100) / 100, MIN_SCALE, MAX_SCALE);
		if (next === label.scale) return;
		label.scale = next;
		r.el.style.fontSize = `${BASE_FONT * next}px`;
		this.commit();
	}

	/** Point the arrow into a quadrant; the label recomposes around it. */
	setDirection(id: number, dir: LabelDirection) {
		const label = this.items.find((l) => l.id === id);
		const r = this.refs.get(id);
		if (!label || !r || label.dir === dir) return;
		label.dir = dir;
		r.el.dataset.dir = dir;
		r.path.setAttribute("d", ARROWS[dir]);
		this.commit();
	}

	destroy() {
		if (!this.supported) return;
		document.removeEventListener("pointerdown", this.onDocPointerDown, true);
		clearTimeout(this.saveTimer);
		this.root.remove();
		releaseStyles();
	}

	handleKey(
		e: KeyboardEvent,
		spawnAt: () => { x: number; y: number },
	): boolean {
		if (!this.supported) return false;
		const isL = e.code === "KeyL" || e.key.toLowerCase() === "l";
		if (isL && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.setHidden(!this._hidden);
			return true;
		}
		if (e.key === "Escape") {
			const active = document.activeElement;
			if (
				active instanceof HTMLElement &&
				active.classList.contains("lb-text") &&
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
		if (isTypingTarget(e.target)) return false;
		if (isL && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			e.preventDefault();
			this.setHidden(false);
			const at = spawnAt();
			this.spawn({ x: at.x, y: at.y });
			return true;
		}
		if (this._hidden || this.selectedId == null) return false;
		const label = this.items.find((l) => l.id === this.selectedId);
		if (!label) return false;
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			this.removeLabel(label.id);
			return true;
		}
		if (
			e.key.toLowerCase() === "f" &&
			!e.shiftKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey
		) {
			e.preventDefault();
			this.setDirection(label.id, MIRROR[label.dir]);
			return true;
		}
		// R cycles the arrow direction clockwise, Alt+R counter-clockwise.
		// Shift+R is excluded — that belongs to ruler-mode.
		const isR = e.code === "KeyR" || e.key.toLowerCase() === "r";
		if (isR && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			this.setDirection(label.id, cycleDirection(label.dir, e.altKey));
			return true;
		}
		const step = e.shiftKey ? 10 : 1;
		let dx = 0;
		let dy = 0;
		if (e.key === "ArrowLeft") dx = -step;
		else if (e.key === "ArrowRight") dx = step;
		else if (e.key === "ArrowUp") dy = -step;
		else if (e.key === "ArrowDown") dy = step;
		if (dx !== 0 || dy !== 0) {
			e.preventDefault();
			label.x += dx;
			label.y += dy;
			this.positionEl(label);
			this.commit();
			return true;
		}
		return false;
	}

	// ------------------------------------------------------------------ dom

	private mountLabel(label: LabelItem) {
		const el = document.createElement("div");
		el.className = "lb-label";
		el.style.fontSize = `${BASE_FONT * label.scale}px`;
		el.style.zIndex = String(++this.zTop);
		el.dataset.dir = label.dir;

		const text = document.createElement("div");
		text.className = "lb-text";
		text.setAttribute("contenteditable", "plaintext-only");
		text.tabIndex = -1; // programmatically focusable everywhere
		text.textContent = label.text;
		text.toggleAttribute("data-empty", label.text.trim() === "");
		text.addEventListener("input", () => {
			label.text = text.textContent ?? "";
			const empty = label.text.trim() === "";
			if (text.hasAttribute("data-empty") !== empty)
				text.toggleAttribute("data-empty", empty);
			this.commit();
		});
		text.addEventListener("focus", () =>
			el.toggleAttribute("data-editing", true),
		);
		text.addEventListener("blur", () => {
			el.toggleAttribute("data-editing", false);
			// normalize the <br> Chrome leaves behind in emptied contenteditables
			if ((text.textContent ?? "").trim() === "" && text.innerHTML !== "")
				text.innerHTML = "";
		});

		const handle = document.createElement("div");
		handle.className = "lb-handle";

		const arrowWrap = document.createElement("div");
		arrowWrap.className = "lb-arrowwrap";
		arrowWrap.innerHTML = ARROW;
		const path = arrowWrap.querySelector<SVGPathElement>("path");
		if (!path) return;
		path.setAttribute("d", ARROWS[label.dir]);
		const aim = document.createElement("div");
		aim.className = "lb-aim";
		arrowWrap.appendChild(aim);

		el.append(text, arrowWrap, handle);

		el.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			this.select(label.id);
			el.style.zIndex = String(++this.zTop);
			if (e.button !== 0) return;
			if (e.target === handle) {
				this.beginScale(e, label);
				return;
			}
			if (e.target === aim) {
				this.beginAim(e, label);
				return;
			}
			// while editing, leave the text alone so native caret/selection works
			if (
				e.target instanceof Node &&
				text.contains(e.target) &&
				document.activeElement === text
			)
				return;
			this.beginDrag(e, label, text);
		});
		arrowWrap
			.querySelector(".lb-arrow")
			?.addEventListener("dblclick", () =>
				this.setDirection(label.id, MIRROR[label.dir]),
			);

		this.root.appendChild(el);
		// engines without plaintext-only support treat the value as invalid and
		// leave the div uneditable — fall back to rich editing (we only read
		// textContent, so pasted markup can't leak through)
		if (!text.isContentEditable) text.setAttribute("contenteditable", "true");
		this.refs.set(label.id, { el, text, path });
		this.positionEl(label);
	}

	private positionEl(label: LabelItem) {
		const r = this.refs.get(label.id);
		if (!r) return;
		r.el.style.transform = `translate3d(${label.x}px,${label.y}px,0)`;
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

	// ----------------------------------------------------------- interaction

	private beginDrag(e: PointerEvent, label: LabelItem, text: HTMLElement) {
		e.preventDefault(); // also suppresses native focus — tap-to-edit below
		e.stopPropagation();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		const originX = e.clientX;
		const originY = e.clientY;
		const startPageX = label.x;
		const startPageY = label.y;
		const downX = e.clientX;
		const downY = e.clientY;
		const tappedText = e.target instanceof Node && text.contains(e.target);
		let moved = false;
		this.prevCursor = document.documentElement.style.cursor;
		document.documentElement.style.cursor = "grabbing";
		const z0 = this.getZoom();

		const onMove = (ev: PointerEvent) => {
			if (
				!moved &&
				Math.abs(ev.clientX - downX) < 3 &&
				Math.abs(ev.clientY - downY) < 3
			)
				return;
			moved = true;
			const z = this.getZoom() || z0;
			const delta = viewportDeltaToPage(
				ev.clientX - originX,
				ev.clientY - originY,
				z,
			);
			const x = startPageX + delta.x;
			const y = startPageY + delta.y;
			if (x !== label.x || y !== label.y) {
				label.x = x;
				label.y = y;
				this.positionEl(label);
			}
		};
		const onEnd = () => {
			target.removeEventListener("pointermove", onMove);
			target.removeEventListener("pointerup", onEnd);
			target.removeEventListener("pointercancel", onEnd);
			document.documentElement.style.cursor = this.prevCursor;
			if (moved) this.commit();
			// a clean tap on the text of a selected label enters editing
			else if (tappedText) this.enterEdit(label.id);
		};
		target.addEventListener("pointermove", onMove);
		target.addEventListener("pointerup", onEnd);
		target.addEventListener("pointercancel", onEnd);
	}

	private beginScale(e: PointerEvent, label: LabelItem) {
		e.preventDefault();
		e.stopPropagation();
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const startScale = label.scale;
		const startDist = Math.max(
			24,
			Math.hypot(e.clientX - box.left, e.clientY - box.top),
		);
		this.prevCursor = document.documentElement.style.cursor;
		document.documentElement.style.cursor = "nwse-resize";

		const onMove = (ev: PointerEvent) => {
			const dist = Math.hypot(ev.clientX - box.left, ev.clientY - box.top);
			this.setScale(label.id, startScale * (dist / startDist));
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

	/**
	 * Aim-handle drag: point the arrow at the thing. The pointer's quadrant
	 * relative to the label's center picks the direction, and the label
	 * recomposes live (text above for "down" arrows, below for "up" ones).
	 */
	private beginAim(e: PointerEvent, label: LabelItem) {
		e.preventDefault();
		e.stopPropagation();
		const r = this.refs.get(label.id);
		if (!r) return;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		let rect = r.el.getBoundingClientRect();
		this.prevCursor = document.documentElement.style.cursor;
		document.documentElement.style.cursor = "crosshair";

		const onMove = (ev: PointerEvent) => {
			const dx = ev.clientX - (rect.left + rect.width / 2);
			const dy = ev.clientY - (rect.top + rect.height / 2);
			const dir = directionFromAim(dx, dy);
			if (dir && dir !== label.dir) {
				this.setDirection(label.id, dir);
				// recomposing moves the box — re-measure so quadrants stay honest
				rect = r.el.getBoundingClientRect();
			}
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

	private onDocPointerDown = (e: PointerEvent) => {
		if (e.target instanceof Node && this.root.contains(e.target)) return;
		this.select(null);
	};

	private select(id: number | null) {
		if (this.selectedId === id) return;
		this.selectedId = id;
		for (const [lid, r] of this.refs)
			r.el.toggleAttribute("data-selected", lid === id);
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
							items: this.items.map((l) => ({
								x: l.x,
								y: l.y,
								s: l.scale,
								d: l.dir,
								t: l.text,
							})),
						}),
					);
				} catch {
					// storage unavailable — labels stay in-memory
				}
			}, 150);
		}
		this.onChange?.(this);
	}

	private loadItems() {
		if (!this.storageKey) return;
		try {
			const raw = localStorage.getItem(this.storageKey);
			if (!raw) return;
			const data = JSON.parse(raw) as {
				v: number;
				items: {
					x: number;
					y: number;
					s: number;
					d?: unknown;
					f?: boolean; // legacy flip flag from before directions existed
					t: string;
				}[];
			};
			if (data.v !== 1 || !Array.isArray(data.items)) return;
			for (const l of data.items) {
				if (typeof l.x !== "number" || typeof l.y !== "number") continue;
				const label: LabelItem = {
					id: this.nextId++,
					x: l.x,
					y: l.y,
					scale:
						typeof l.s === "number" ? clamp(l.s, MIN_SCALE, MAX_SCALE) : 1,
					dir: isDirection(l.d) ? l.d : l.f ? "dl" : "dr",
					text: typeof l.t === "string" ? l.t : "",
				};
				this.items.push(label);
				this.mountLabel(label);
			}
		} catch {
			// corrupt payload — start with no labels
		}
	}
}
