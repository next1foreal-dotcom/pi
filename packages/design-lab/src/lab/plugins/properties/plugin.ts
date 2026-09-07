import type { LabPlugin, LabPluginContext, LabPluginHandle } from "../../plugin-api";

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
};

const STYLE_ID = "lab-properties-style";
const CSS = `
.pp-panel{position:fixed;right:12px;top:12px;width:280px;max-height:calc(100vh - 24px);overflow:auto;
 display:none;flex-direction:column;gap:8px;padding:10px 11px;border-radius:8px;pointer-events:auto;
 background:var(--lab-pill,rgba(28,28,28,.92));color:var(--lab-chrome,#f1f1f1);
 font:12px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;
 box-shadow:0 8px 30px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);z-index:7}
.pp-panel[data-show]{display:flex}
.pp-tag{font:600 13px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-where{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.62;word-break:break-all}
.pp-section{font:600 10px/1.2 ui-sans-serif,system-ui;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin-top:2px}
.pp-chips{display:flex;flex-wrap:wrap;gap:4px}
.pp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 6px;border-radius:4px;
 background:rgba(255,255,255,.09);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-chip button{all:unset;cursor:pointer;opacity:.5;padding:0 2px;line-height:1}
.pp-chip button:hover{opacity:1}
.pp-add{all:unset;box-sizing:border-box;width:100%;padding:4px 6px;border-radius:4px;
 background:rgba(255,255,255,.07);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.pp-add::placeholder{opacity:.4}
.pp-note{font:11px/1.4 ui-sans-serif,system-ui;opacity:.66}
.pp-note[data-bad]{opacity:1;color:#f39a5e}
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

class Properties {
	private readonly panel: HTMLDivElement;
	private readonly tagEl: HTMLDivElement;
	private readonly whereEl: HTMLDivElement;
	private readonly chips: HTMLDivElement;
	private readonly add: HTMLInputElement;
	private readonly note: HTMLDivElement;
	private shown: Selection | null = null;
	private busy = false;
	/** A write just landed; hold the message until the next real selection. */
	private pending = false;
	private closed = false;

	constructor(host: HTMLElement) {
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
		this.note = document.createElement("div");
		this.note.className = "pp-note";

		this.panel.append(this.tagEl, this.whereEl, classesLabel, this.chips, this.add, this.note);
		host.appendChild(this.panel);

		this.add.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const value = this.add.value.trim();
			if (value) void this.write({ add: value });
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
			this.note.textContent = "改好了 · 再点一下它继续改";
		}
	};

	private render(): void {
		const sel = this.shown;
		const state = editability(sel);
		this.panel.toggleAttribute("data-show", state.show);
		if (!sel || !state.show) return;

		this.tagEl.textContent = sel.component ? `<${sel.tag}> · ${sel.component}` : `<${sel.tag}>`;
		this.whereEl.textContent =
			sel.file && sel.line !== null ? `${sel.file}:${sel.line}:${sel.column}` : (sel.problem ?? "");

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
				x.addEventListener("click", () => void this.write({ remove: name }));
				chip.appendChild(x);
			}
			this.chips.appendChild(chip);
		}

		this.add.style.display = state.editable ? "" : "none";
		this.note.textContent = state.note ?? "";
		this.note.toggleAttribute("data-bad", state.bad);
	}

	/**
	 * One edit, then re-find the element.
	 *
	 * The write makes vite replace the module, which replaces the node the
	 * selection points at — so holding the old handle would leave the panel
	 * describing something that is no longer on screen. The outline's own rect
	 * is the way back: the same place, whatever node is there now.
	 */
	private async write(change: { add?: string; remove?: string }): Promise<void> {
		const sel = this.shown;
		if (!sel || !editability(sel).editable || this.busy) return;
		this.busy = true;
		this.note.textContent = "写入中…";
		this.note.removeAttribute("data-bad");
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
			const body = (await res.json()) as { ok?: boolean; error?: string };
			if (!res.ok || !body.ok) {
				this.note.textContent = body.error ?? `写不进去(HTTP ${res.status})`;
				this.note.setAttribute("data-bad", "");
				return;
			}
			this.add.value = "";
			// The write makes vite replace the module, which replaces the node this
			// selection points at. Two ways back were tried and neither survives
			// contact with the running lab: the old pixel usually moves, because
			// the edit is why the layout changed, and the node's position in the
			// tree does not find it either once the screen remounts. So say what
			// happened and let the next click re-select, rather than leave the
			// panel confidently describing a node that is no longer there — the
			// second is how you edit the wrong thing next.
			this.note.textContent = "改好了 · 再点一下它继续改";
			this.note.removeAttribute("data-bad");
			this.shown = null;
			this.pending = true;
		} finally {
			this.busy = false;
			this.sync();
		}
	}

	destroy(): void {
		this.closed = true;
		this.panel.remove();
	}
}

export const plugin: LabPlugin = {
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
	],
	mount(ctx: LabPluginContext): LabPluginHandle | null {
		if (typeof document === "undefined") return null;
		const panel = new Properties(ctx.host);
		// A selection only changes from a click or an api call. The first is
		// caught here, the second by refresh(); polling every frame to catch a
		// call nobody made would be paying rent on the rare case.
		const onUp = () => setTimeout(panel.sync, 0);
		window.addEventListener("pointerup", onUp, true);
		return {
			onCameraWrite: panel.sync,
			api: {
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
			},
			destroy() {
				window.removeEventListener("pointerup", onUp, true);
				panel.destroy();
			},
		};
	},
};

export default plugin;
