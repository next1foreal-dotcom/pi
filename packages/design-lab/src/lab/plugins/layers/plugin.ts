import type { LabPlugin, LabPluginContext, LabPluginHandle } from "../../plugin-api";
import { SKIP_HOSTS } from "../inspect/plugin";

/**
 * The canvas, read as a list.
 *
 * NOT the `labels` plugin one folder up the alphabet — that one draws text on
 * the canvas. This one is a tree of what is ON the screens.
 *
 * ── why a list at all, on a canvas ───────────────────────────────────────
 * Because pointing is only good for what you can see. A section scrolled out
 * of a frame, a wrapper with no paint of its own, the element behind the
 * element — none of those can be hovered, and all of them are things you end
 * up wanting to talk about. doop puts a LAYERS panel down the left side for
 * exactly this and it is the half of its element layer that hovering does not
 * cover.
 *
 * ── what ours knows that doop's cannot ───────────────────────────────────
 * doop's frames are sandboxed iframes of served HTML, so its tree is rebuilt
 * from the document it shipped and every row has to carry a css path back to
 * the node, kept in step on both sides. Ours are React components in this
 * document: a row IS the node. Selecting from a row and selecting by clicking
 * the canvas end in the same call with the same argument, which is why this
 * plugin holds no state about the selection at all — it asks `inspect` and
 * marks whichever row is holding that node.
 *
 * ── it is deliberately a DOM tree, not a component tree ──────────────────
 * The component that rendered a tag is worth showing and is shown, but the
 * rows are elements, because elements are what everything else here addresses:
 * the outline, the toolbar, the class editor, the text edit, the comment. A
 * tree whose rows were components would be a tree you cannot click through to
 * any of that.
 *
 * ── cost ─────────────────────────────────────────────────────────────────
 * Nothing is walked until it is opened. A closed screen costs one row; an open
 * one costs its children and stops. Rows are labelled from `tagName` and the
 * class attribute, which are free — a source location is asked for only when
 * a node is actually selected, and that is `inspect`'s job, not this one's.
 */

const CSS = `
.ly-panel{position:fixed;left:12px;top:12px;width:236px;max-height:calc(100vh - 24px);
 display:none;flex-direction:column;gap:6px;padding:9px 10px;border-radius:8px;pointer-events:auto;
 background:var(--lab-pill,rgba(28,28,28,.92));color:var(--lab-chrome,#f1f1f1);
 font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;
 box-shadow:0 8px 30px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);z-index:7}
.ly-panel[data-show]{display:flex}
.ly-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.ly-title{font:600 10px/1.2 ui-sans-serif,system-ui;letter-spacing:.06em;text-transform:uppercase;opacity:.5}
.ly-fold{margin-left:auto;opacity:.5;font:10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ly-head:hover .ly-fold,.ly-head:hover .ly-title{opacity:.85}
.ly-list{overflow-y:auto;overflow-x:hidden;min-height:0}
.ly-panel[data-folded] .ly-list{display:none}
.ly-row{display:flex;align-items:center;gap:3px;width:100%;padding:2px 4px;border-radius:4px;
 cursor:default;white-space:nowrap;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ly-row:hover{background:rgba(255,255,255,.09)}
.ly-row[data-on]{background:rgba(255,255,255,.17)}
.ly-twist{flex:none;width:11px;text-align:center;opacity:.5;cursor:pointer}
.ly-twist[data-leaf]{opacity:0;cursor:default}
.ly-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ly-screen{font-weight:600}
.ly-of{flex:none;margin-left:4px;opacity:.42;font:10px/1.5 ui-sans-serif,system-ui}
.ly-empty{opacity:.5;font-style:italic;padding:2px 4px}
`;

/** How deep a row can indent before the indent stops growing and the text wins. */
const INDENT_MAX = 9;
const INDENT_PX = 9;
/** Remembered per browser, and only ever a convenience. */
const FOLD_KEY = "lab.layers.folded";

let styleRefs = 0;
let styleEl: HTMLStyleElement | null = null;

function acquireStyles(): void {
	if (styleRefs++ === 0) {
		document.querySelectorAll("style[data-lab-layers]").forEach((el) => {
			el.remove();
		});
		styleEl = document.createElement("style");
		styleEl.dataset.labLayers = "";
		styleEl.textContent = CSS;
		document.head.appendChild(styleEl);
	}
}

function releaseStyles(): void {
	if (--styleRefs === 0) {
		styleEl?.remove();
		styleEl = null;
	}
}

type InspectApi = {
	selectElement(el: Element): unknown;
	selectedElement(): Element | null;
	hoverElement(el: Element | null): boolean;
};

/** `div.lp-hero`, or `h1` when it wears no class. What the outline badge says. */
export function labelOf(el: Element): string {
	const tag = el.tagName.toLowerCase();
	const first = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0];
	return first ? `${tag}.${first}` : tag;
}

/**
 * The children worth listing.
 *
 * Lab chrome is not part of anyone's design: notes, labels, rulers and every
 * overlay this lab draws are dropped here the same way the hit test drops
 * them, from the same list, so a row can never point at something the canvas
 * would refuse to select.
 */
export function listChildren(el: Element): Element[] {
	const out: Element[] = [];
	const kids = el.children;
	for (let i = 0; i < kids.length; i++) {
		const kid = kids[i];
		if (!kid) continue;
		if (kid.matches(SKIP_HOSTS) || kid.closest(SKIP_HOSTS)) continue;
		out.push(kid);
	}
	return out;
}

/**
 * Every screen on the canvas, and the node whose children are its design.
 *
 * One step in from the scroller: `screen-frame` wraps every screen in a
 * `[data-screen-content]` div that carries the frame's size and none of the
 * page. Rooting here rather than at the scroller is the difference between a
 * screen opening onto its own first element and opening onto one row of the
 * lab's plumbing that everyone then has to click through. The wrapper is still
 * selectable on the canvas -- it is just not the tree's idea of the top.
 */
export function screenRoots(doc: Document): { id: string; root: Element }[] {
	const out: { id: string; root: Element }[] = [];
	doc.querySelectorAll("[data-screen-scroll]").forEach((scroll) => {
		const id = scroll.closest("[data-screen-id]")?.getAttribute("data-screen-id");
		if (!id) return;
		const inner = scroll.querySelector("[data-screen-content]");
		out.push({ id, root: inner ?? scroll });
	});
	return out;
}

export class LayersPanel {
	private panel: HTMLDivElement;
	private list: HTMLDivElement;
	private fold: HTMLSpanElement;
	private open = new Set<Element>();
	private rows = new Map<Element, HTMLElement>();
	private closed = false;
	private folded = false;

	constructor(private host: HTMLElement) {
		acquireStyles();
		this.panel = document.createElement("div");
		this.panel.className = "ly-panel";
		// The lesson the element toolbar paid for: a press the canvas does not
		// recognise starts a pan, takes a pointer capture on the root and
		// preventDefaults the pointerdown -- which kills the click that never
		// arrives. Chrome says so about itself.
		this.panel.dataset.labChrome = "";

		const head = document.createElement("div");
		head.className = "ly-head";
		const title = document.createElement("span");
		title.className = "ly-title";
		// English caps, like every other section label in this lab's panels
		// (CLASSES, SPACING, METER, LOOK). Not only for consistency: `.pp-section`
		// ends its font stack at `system-ui` with no generic fallback, which no
		// Latin label ever noticed — set 图层 in it and it renders as two tofu
		// boxes, which is what the first screenshot of this panel showed.
		title.textContent = "LAYERS";
		this.fold = document.createElement("span");
		this.fold.className = "ly-fold";
		head.append(title, this.fold);
		head.addEventListener("click", () => this.setFolded(!this.folded));

		this.list = document.createElement("div");
		this.list.className = "ly-list";
		this.panel.append(head, this.list);
		host.appendChild(this.panel);

		this.setFolded(readFolded());
		this.render();
		window.addEventListener("pointerup", this.onUp, true);
	}

	/**
	 * A selection only changes from a click or an api call, so the tree is
	 * re-read after a press rather than every frame. The api call has
	 * `refresh()`; this is the other half, and it is the same bargain the
	 * properties panel strikes for the same reason.
	 */
	private onUp = (): void => {
		setTimeout(() => {
			if (this.closed) return;
			this.render();
			// Selecting on the canvas opens the tree to it. That is the whole
			// point of having both: point at a thing and the list says where it
			// lives; pick from the list and the canvas outlines it. Only when
			// the row is not already on screen, so a press does not fight
			// whatever branches were deliberately closed.
			const selected = this.inspect()?.selectedElement() ?? null;
			if (selected && !this.rows.has(selected)) this.reveal(selected);
		}, 0);
	};

	private inspect(): InspectApi | undefined {
		return window.lab?.plugin("inspect") as InspectApi | undefined;
	}

	setFolded(folded: boolean): void {
		this.folded = folded;
		this.panel.toggleAttribute("data-folded", folded);
		this.fold.textContent = folded ? "+" : "−";
		writeFolded(folded);
	}

	/** Re-read the canvas and re-mark, keeping whatever is open open. */
	refresh(): void {
		if (this.closed) return;
		this.render();
	}

	/**
	 * Open every ancestor of a node and put its row on screen.
	 *
	 * The panel is only half useful if it can show you where you are but not
	 * take you there: clicking a heading three frames away should leave the
	 * tree standing on that heading, opened.
	 */
	reveal(el: Element): boolean {
		if (this.closed) return false;
		const scroll = el.closest("[data-screen-scroll]");
		if (!scroll) return false;
		// Open up to the tree's own root, which is the content wrapper when the
		// frame has one -- opening past it would mark nodes that have no row.
		const root = scroll.querySelector("[data-screen-content]") ?? scroll;
		this.open.add(root);
		let node: Element | null = el.parentElement;
		while (node && node !== root && root.contains(node)) {
			this.open.add(node);
			node = node.parentElement;
		}
		if (this.folded) this.setFolded(false);
		this.render();
		// jsdom has no scroller, so this is a seam and not a direct call.
		this.rows.get(el)?.scrollIntoView?.({ block: "nearest" });
		return true;
	}

	private render(): void {
		const doc = this.host.ownerDocument;
		const roots = screenRoots(doc);
		const selected = this.inspect()?.selectedElement() ?? null;
		this.rows.clear();
		this.list.replaceChildren();
		this.panel.toggleAttribute("data-show", true);
		if (roots.length === 0) {
			const empty = document.createElement("div");
			empty.className = "ly-empty";
			empty.textContent = "画布上还没有屏幕";
			this.list.appendChild(empty);
			return;
		}
		for (const { id, root } of roots) {
			this.addRow(root, 0, selected, id);
			if (this.open.has(root)) this.addChildren(root, 1, selected);
		}
	}

	private addChildren(el: Element, depth: number, selected: Element | null): void {
		for (const kid of listChildren(el)) {
			this.addRow(kid, depth, selected, null);
			if (this.open.has(kid)) this.addChildren(kid, depth + 1, selected);
		}
	}

	private addRow(
		el: Element,
		depth: number,
		selected: Element | null,
		screenId: string | null,
	): void {
		const row = document.createElement("div");
		row.className = "ly-row";
		row.style.paddingLeft = `${4 + Math.min(depth, INDENT_MAX) * INDENT_PX}px`;
		if (el === selected) row.setAttribute("data-on", "");

		const twist = document.createElement("span");
		twist.className = "ly-twist";
		const kids = listChildren(el);
		if (kids.length === 0) twist.setAttribute("data-leaf", "");
		else twist.textContent = this.open.has(el) ? "▾" : "▸";
		twist.addEventListener("click", (e) => {
			if (kids.length === 0) return;
			// The twist is about the tree; the row is about the element. Letting
			// this reach the row would select something every time you opened a
			// branch to look inside it.
			e.stopPropagation();
			if (this.open.has(el)) this.open.delete(el);
			else this.open.add(el);
			this.render();
		});

		const name = document.createElement("span");
		name.className = "ly-name";
		if (screenId) {
			name.classList.add("ly-screen");
			name.textContent = screenId;
		} else {
			name.textContent = labelOf(el);
		}

		row.append(twist, name);
		if (!screenId && kids.length > 0) {
			const count = document.createElement("span");
			count.className = "ly-of";
			count.textContent = String(kids.length);
			row.appendChild(count);
		}

		// A screen row addresses a scroller, and the canvas refuses to select a
		// scroller — it is the frame, not anything in the design. So it opens
		// and closes and lights nothing; the rows under it are the answers.
		if (!screenId) {
			row.addEventListener("pointerenter", () => {
				this.inspect()?.hoverElement(el);
			});
			row.addEventListener("pointerleave", () => {
				this.inspect()?.hoverElement(null);
			});
			row.addEventListener("click", () => {
				this.inspect()?.selectElement(el);
				this.render();
			});
		} else {
			row.addEventListener("click", () => {
				if (this.open.has(el)) this.open.delete(el);
				else this.open.add(el);
				this.render();
			});
		}

		this.rows.set(el, row);
		this.list.appendChild(row);
	}

	/** What the panel is showing, for a caller with no eyes. */
	state(): { folded: boolean; rows: number; open: number; selected: string | null } {
		const selected = this.inspect()?.selectedElement() ?? null;
		return {
			folded: this.folded,
			rows: this.rows.size,
			open: this.open.size,
			selected: selected ? labelOf(selected) : null,
		};
	}

	destroy(): void {
		if (this.closed) return;
		this.closed = true;
		window.removeEventListener("pointerup", this.onUp, true);
		this.panel.remove();
		this.open.clear();
		this.rows.clear();
		releaseStyles();
	}
}

function readFolded(): boolean {
	try {
		return localStorage.getItem(FOLD_KEY) === "1";
	} catch {
		// Private window, blocked site data, a preview that throws on access.
		// The panel opens; that is the better half of the guess.
		return false;
	}
}

function writeFolded(folded: boolean): void {
	try {
		localStorage.setItem(FOLD_KEY, folded ? "1" : "0");
	} catch {
		// Nothing to do and nothing worth saying. It is a fold state.
	}
}

export const plugin: LabPlugin = {
	id: "layers",
	order: 64,
	// No hostSelector, for the reason the properties panel gives: the chrome
	// host in the JSX is display:none in the locked modes, and the layer that
	// holds the screens carries the camera transform, which would drag a fixed
	// panel around with the canvas.
	describe: [
		{
			name: "state",
			signature:
				"state(): { folded: boolean; rows: number; open: number; selected: string | null }",
			summary:
				"What the tree is showing. `rows` counts the rows currently rendered, which is one per screen plus the children of everything opened — not the size of the page. `selected` is the label of the row marked as selected (`div.lp-hero`, or a bare tag when it has no class), or null when the selection is elsewhere or empty.",
		},
		{
			name: "reveal",
			signature: "reveal(el: Element): boolean",
			summary:
				"Open every ancestor of a node, unfold the panel if it was folded, and scroll that node's row into view. False when the node is not inside a screen. This is what selecting on the canvas should be followed by when you want the tree to keep up.",
		},
		{
			name: "refresh",
			signature: "refresh(): void",
			summary:
				"Re-read the canvas and re-mark the selected row, keeping open branches open. A press does this on its own; call it after selecting through an api, which the panel cannot see.",
		},
		{
			name: "setFolded",
			signature: "setFolded(folded: boolean): void",
			summary:
				"Fold the tree away to its header, or bring it back. Remembered per browser. The header does the same thing when clicked.",
		},
	],
	mount(ctx: LabPluginContext): LabPluginHandle | null {
		if (typeof document === "undefined") return null;
		const panel = new LayersPanel(ctx.host);
		return {
			api: {
				state: () => panel.state(),
				reveal: (el: Element) => panel.reveal(el),
				refresh: () => panel.refresh(),
				setFolded: (folded: boolean) => panel.setFolded(folded),
			},
			destroy: () => panel.destroy(),
		};
	},
};

export default plugin;
