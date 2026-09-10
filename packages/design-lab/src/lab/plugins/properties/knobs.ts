/**
 * The declared knobs of the component the selected element belongs to, drawn
 * as controls that write his source.
 *
 * Three things already existed and this is the fourth. The index reads
 * `@editor` off a prop declaration and says what control it wants; the
 * components plugin can say which component an element belongs to; and
 * `/__lab-fs/element/prop` rewrites one attribute on one tag. What was missing
 * was the thing in the middle — turning a declaration into something he can
 * turn.
 *
 * Two rules shape everything below.
 *
 * A control is only ever built from `@editor`. A number is not a range, a
 * string is not a colour, and a union of six is not a curated palette of two —
 * the index refused to guess those and this refuses for the same reason. A
 * prop with no tag gets no control, and that is the whole rule.
 *
 * A control that cannot write is disabled BEFORE he touches it, and says why in
 * the editor's own words. Every other prop on this canvas is passed as an
 * expression (`product={product}`), which the editor refuses and should. A
 * slider over one of those would move, snap back, and teach him the panel is
 * decorative.
 */

import { expectFor, pushHistory, type HistoryCommand } from "../../core/history";
import type {
	ComponentEntry,
	ComponentIndex,
	ComponentInstance,
	EditorSpec,
} from "../../components/types";

/** One control's worth of the index: the declaration plus what the type said. */
export type KnobSpec = {
	name: string;
	editor: EditorSpec;
	type: string;
	literalValues?: string[];
};

/** Where props that named no `section=` go. Last, so named groups read first. */
export const UNSECTIONED = "其它";

export type KnobSection = { name: string; knobs: KnobSpec[] };

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The props that asked for a control.
 *
 * Note what is NOT here: everything else. `children`, `product`, `onClose` all
 * have types the compiler read perfectly well, and none of them says what
 * control to build.
 */
export function knobsOf(entry: ComponentEntry | null): KnobSpec[] {
	if (!entry) return [];
	const out: KnobSpec[] = [];
	for (const p of entry.props) {
		if (!p.editor) continue;
		const knob: KnobSpec = { name: p.name, editor: p.editor, type: p.type };
		if (p.literalValues) knob.literalValues = p.literalValues.slice();
		out.push(knob);
	}
	return out;
}

/**
 * Group by `section=`, keeping the order the sections were first declared in.
 * A Map, not a sort: the author's order is the only order that means anything
 * here, and alphabetical would scatter a group he wrote together.
 */
export function sectionsOf(knobs: KnobSpec[]): KnobSection[] {
	const named = new Map<string, KnobSpec[]>();
	const rest: KnobSpec[] = [];
	for (const knob of knobs) {
		const section = knob.editor.section;
		if (!section) {
			rest.push(knob);
			continue;
		}
		const list = named.get(section);
		if (list) list.push(knob);
		else named.set(section, [knob]);
	}
	const out: KnobSection[] = [];
	named.forEach((list, name) => {
		out.push({ name, knobs: list });
	});
	if (rest.length > 0) out.push({ name: UNSECTIONED, knobs: rest });
	return out;
}

/** An enum's candidates: what was declared, else what the type allows. */
export function optionsFor(knob: KnobSpec): string[] {
	if (knob.editor.kind !== "enum") return [];
	const declared = knob.editor.options;
	if (declared && declared.length > 0) return declared.slice();
	return knob.literalValues ? knob.literalValues.slice() : [];
}

/** The body field `/__lab-fs/element/prop` takes. Never raw source to splice. */
export type WriteValue =
	| { as: "string"; value: string }
	| { as: "expression"; value: string | number | boolean | null };

/**
 * A control's value as the attribute it should become.
 *
 * The syntax is not cosmetic: `tone="loud"` is a string and `tone={loud}` is an
 * identifier that does not exist. Null means the control produced something the
 * type does not allow, and nothing is sent.
 */
export function writeFor(knob: KnobSpec, raw: string | number | boolean): WriteValue | null {
	switch (knob.editor.kind) {
		case "range":
		case "int": {
			if (typeof raw === "boolean") return null;
			const n = typeof raw === "number" ? raw : Number(String(raw).trim());
			if (String(raw).trim() === "" || !Number.isFinite(n)) return null;
			return { as: "expression", value: knob.editor.kind === "int" ? Math.round(n) : n };
		}
		case "boolean":
			return { as: "expression", value: raw === true || raw === "true" };
		case "enum": {
			const value = String(raw);
			const options = optionsFor(knob);
			if (options.length > 0 && !options.includes(value)) return null;
			return { as: "string", value };
		}
		case "color": {
			const value = String(raw).trim();
			if (!HEX.test(value)) return null;
			return { as: "string", value };
		}
	}
}

/**
 * The question "can this prop be written", asked as a write that is always
 * refused on the way out.
 *
 * There is no read endpoint and there should not be a second one: the only
 * thing that can say whether the editor will rewrite a given attribute is the
 * editor. So the panel sends a write whose VALUE the editor refuses last, after
 * it has already checked the location, the tag, whether the current value is a
 * literal, and whether a spread stands in the way. Getting the value refusal
 * back means every other gate passed — and no byte was written, because the
 * refusal happens before the new source is built.
 *
 * Both quote characters, deliberately. `editProp` refuses a quoted attribute
 * whose value contains the quote it is about to use, and it uses the quote the
 * attribute already has: a probe of `"` alone sails through a `tone='quiet'`
 * and rewrites his file. That is a test in knobs.test.ts, against the real
 * editor, because it is exactly the kind of thing that looks fine.
 */
export const PROBE_VALUE: WriteValue = { as: "string", value: "\"'" };

export type Probe = { writable: boolean; note: string | null };

export type PropReply = {
	ok?: boolean;
	error?: string;
	problem?: string;
	changed?: boolean;
	before?: string;
	after?: string;
};

export function classifyProbe(status: number, body: PropReply): Probe {
	if (status === 200) return { writable: true, note: null };
	if (status === 409 && body.problem === "unsafe-value") return { writable: true, note: null };
	const note = typeof body.error === "string" && body.error ? body.error : `写不进去(HTTP ${status})`;
	return { writable: false, note };
}

export type InstancePick =
	| { kind: "one"; instance: ComponentInstance }
	| { kind: "none" }
	| { kind: "many"; count: number };

/**
 * Which call site the selected element came from.
 *
 * The components plugin answers "which component" by walking React's owner
 * chain; it does not hand back which of that component's tag sites the walk
 * matched. The screen narrows it, and one call site on the screen is the answer.
 * Two is not: picking the first would put the controls on a tag he is not
 * looking at and write there, which is the failure this whole panel exists to
 * avoid. So two is a refusal with the count in it.
 */
export function pickInstance(
	instances: ComponentInstance[],
	screenId: string | null,
): InstancePick {
	if (screenId === null) return { kind: "none" };
	const here = instances.filter((at) => at.screenId === screenId);
	if (here.length === 0) return { kind: "none" };
	if (here.length > 1) return { kind: "many", count: here.length };
	return { kind: "one", instance: here[0] };
}

/** Enough of a fiber to read props off it. React's own shape, narrowed. */
export type PropsFiber = {
	return?: PropsFiber | null;
	type?: unknown;
	memoizedProps?: unknown;
};

/** The component name React would show, through memo and forwardRef wrappers. */
export function fiberComponentName(type: unknown, depth = 0): string | null {
	if (depth > 4) return null;
	if (typeof type === "function") {
		const fn = type as { displayName?: unknown; name?: unknown };
		if (typeof fn.displayName === "string" && fn.displayName) return fn.displayName;
		return typeof fn.name === "string" && fn.name ? fn.name : null;
	}
	if (type && typeof type === "object") {
		const box = type as { displayName?: unknown; render?: unknown; type?: unknown };
		if (typeof box.displayName === "string" && box.displayName) return box.displayName;
		if (box.render !== undefined) return fiberComponentName(box.render, depth + 1);
		if (box.type !== undefined) return fiberComponentName(box.type, depth + 1);
	}
	return null;
}

/**
 * What that component was actually handed, read off the live fiber rather than
 * parsed back out of the file.
 *
 * The source says what the call site wrote; this says what the component got,
 * which is the number the control has to start at. Nearest match wins, so a
 * Tile inside a Tile reads the inner one's props — the same rule the components
 * plugin uses to decide which instance an element belongs to.
 */
export function propsOfComponent(
	start: PropsFiber | null | undefined,
	name: string,
): Record<string, unknown> | null {
	const seen = new Set<PropsFiber>();
	let cur: PropsFiber | null | undefined = start;
	while (cur && !seen.has(cur)) {
		seen.add(cur);
		if (fiberComponentName(cur.type) === name) {
			const props = cur.memoizedProps;
			return props && typeof props === "object" ? (props as Record<string, unknown>) : null;
		}
		cur = cur.return ?? null;
	}
	return null;
}

/**
 * Is the value we just wrote the one this render is showing?
 *
 * Sibling of `editLanded`, and for the same reason: after the write the OLD
 * render is still standing at the same source position until vite catches up,
 * so position alone would hand back the node that is about to disappear.
 */
export function knobLanded(
	props: Record<string, unknown> | null,
	prop: string,
	value: string | number | boolean,
): boolean {
	if (!props) return false;
	return Object.hasOwn(props, prop) && props[prop] === value;
}

/** Six-digit, because `<input type="color">` will not take anything else. */
function widenHex(value: string): string {
	if (value.length !== 4) return value;
	const [, r, g, b] = value;
	return `#${r}${r}${g}${g}${b}${b}`;
}

/**
 * What the control shows before he touches it.
 *
 * `undefined` is the normal case, not an error: a destructuring default never
 * reaches `memoizedProps`, so a prop left off the tag arrives here as nothing.
 * A blank slider would read as "zero", which is a different claim.
 */
export function displayValue(knob: KnobSpec, raw: unknown): string | number | boolean {
	switch (knob.editor.kind) {
		case "range":
		case "int":
			if (typeof raw === "number" && Number.isFinite(raw)) return raw;
			return knob.editor.min ?? 0;
		case "boolean":
			return raw === true;
		case "enum": {
			const options = optionsFor(knob);
			if (typeof raw === "string" && (options.length === 0 || options.includes(raw))) return raw;
			return options[0] ?? "";
		}
		case "color":
			if (typeof raw === "string" && HEX.test(raw)) return widenHex(raw);
			return "#000000";
	}
}

// ────────────────────────────────── the view ─────────────────────────────────

export type PropPost = {
	file: string;
	line: number;
	column: number;
	tag: string;
	prop: string;
	value: WriteValue;
};

export type PropAnswer = { status: number; body: PropReply };

/** What an undo may write back: a value, or the attribute lifted off again. */
export type PropUndoValue = WriteValue | { as: "remove" };

/**
 * The step that takes one turn back, or null when there is nothing to take back.
 *
 * `previous` comes in with the turn rather than out of the source. The panel
 * read it off the fiber when it drew the control; the alternative — parsing the
 * attribute text the server hands back as `before` — would be a fourth parser of
 * the same JSX in a fourth place, kept in step with the other three by hand.
 *
 * `before === ""` is the server saying the tag carried no such attribute at all,
 * and the way back from that is to lift it off again. Writing the fiber's old
 * value would nail the component's own default into his source as if he had
 * typed it, and the next time that default changed his tag would not follow.
 */
export function propEditCommand(
	post: PropPost,
	previous: string | number | boolean,
	knob: KnobSpec,
	reply: PropReply,
): HistoryCommand | null {
	if (reply.ok !== true || reply.changed !== true) return null;
	if (typeof reply.before !== "string" || typeof reply.after !== "string") return null;
	const back: PropUndoValue | null =
		reply.before === "" ? { as: "remove" } : writeFor(knob, previous);
	// No value this knob can write means no way back. A step that fails at the
	// far end, minutes later, is worse than one that was never offered.
	if (!back) return null;
	return {
		type: "source-edit",
		endpoint: "prop",
		what: `拧 ${post.prop}`,
		undo: { body: { ...post, value: back }, expect: expectFor(reply.after) },
		redo: { body: { ...post }, expect: expectFor(reply.before) },
	};
}

/** What the live panel uses; a seam so the rules above can be driven in a test. */
export type KnobsDeps = {
	loadIndex(): Promise<ComponentIndex>;
	componentAt(el: Element): Promise<string | null>;
	fiberOf(el: Element): PropsFiber | null;
	post(body: PropPost): Promise<PropAnswer>;
	/**
	 * Wait for the write to reach the screen and hand the element back, the way
	 * the class-list edits do. Null means it never came back.
	 */
	settle(check: (el: Element) => boolean): Promise<Element | null>;
	/**
	 * Hold the panel still for the length of a turn.
	 *
	 * Not bookkeeping — the reason is that the click which turns a knob also
	 * clears the inspect plugin's selection (it listens on window in the capture
	 * phase, a phase before this panel can stop the event). Without this the
	 * panel drops the selection it is holding while its own write is still in
	 * flight, and there is nothing left to put the element back into.
	 */
	busy(on: boolean): void;
};

export type KnobsTarget = { el: Element | null; screenId: string | null };

const STYLE_ID = "lab-knobs-style";
const CSS = `
.pk-root{display:none;flex-direction:column;gap:6px;margin-top:2px;
 border-top:1px solid rgba(255,255,255,.12);padding-top:8px}
.pk-root[data-show]{display:flex}
.pk-lead{font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.62}
.pk-warn{font:11px/1.4 ui-sans-serif,system-ui;opacity:.62}
.pk-warn:empty{display:none}
.pk-lead:empty{display:none}
.pk-section{font:600 10px/1.2 ui-sans-serif,system-ui;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin-top:4px}
.pk-row{display:flex;align-items:center;gap:8px;min-height:20px}
.pk-name{flex:0 0 68px;font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.82;
 overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-ctl{flex:1 1 auto;min-width:0;accent-color:#d8d8d8}
.pk-ctl:disabled{opacity:.38;cursor:not-allowed}
select.pk-ctl,input[type=number].pk-ctl{all:unset;box-sizing:border-box;padding:3px 6px;border-radius:4px;
 background:rgba(255,255,255,.07);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
 color:inherit;cursor:pointer}
select.pk-ctl:disabled,input[type=number].pk-ctl:disabled{opacity:.38;cursor:not-allowed}
input[type=color].pk-ctl{flex:0 0 28px;height:20px;padding:0;border:1px solid rgba(255,255,255,.18);
 border-radius:4px;background:none;cursor:pointer}
input[type=checkbox].pk-ctl{flex:0 0 auto;cursor:pointer}
.pk-val{flex:0 0 auto;min-width:40px;text-align:right;
 font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.62}
.pk-why{font:11px/1.4 ui-sans-serif,system-ui;opacity:.72;padding-left:2px}
`;

function injectStyle(): void {
	if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = CSS;
	document.head.appendChild(el);
}

function probeKey(at: ComponentInstance, prop: string): string {
	return `${at.file}:${at.line}:${at.column}|${prop}`;
}

/** What one row is showing right now. Read by tests and by the plugin api. */
export type KnobRow = {
	name: string;
	kind: EditorSpec["kind"];
	value: string | number | boolean;
	writable: boolean;
	note: string | null;
};

export type KnobsState = {
	showing: boolean;
	component: string | null;
	instance: ComponentInstance | null;
	rows: KnobRow[];
	warning: string | null;
};

export class Knobs {
	private readonly deps: KnobsDeps;
	private readonly root: HTMLDivElement;
	private readonly lead: HTMLDivElement;
	private readonly warn: HTMLDivElement;
	private readonly body: HTMLDivElement;
	private index: ComponentIndex | null = null;
	private probes = new Map<string, Probe>();
	private generation = 0;
	private closed = false;
	private state: KnobsState = {
		showing: false,
		component: null,
		instance: null,
		rows: [],
		warning: null,
	};

	constructor(host: HTMLElement, deps: KnobsDeps) {
		this.deps = deps;
		injectStyle();
		this.root = document.createElement("div");
		this.root.className = "pk-root";
		this.root.setAttribute("data-properties-knobs", "");
		this.lead = document.createElement("div");
		this.lead.className = "pk-lead";
		this.warn = document.createElement("div");
		this.warn.className = "pk-warn";
		this.body = document.createElement("div");
		this.body.className = "pk-body";
		this.root.append(this.lead, this.warn, this.body);
		host.appendChild(this.root);
	}

	/** What the panel is offering. Null-ish fields when nothing is selected. */
	read(): KnobsState {
		return {
			...this.state,
			rows: this.state.rows.map((r) => ({ ...r })),
		};
	}

	/** Drop the cached index so the next look re-reads it from the server. */
	forget(): void {
		this.index = null;
		this.probes.clear();
	}

	private async ready(): Promise<ComponentIndex> {
		if (this.index) return this.index;
		const loaded = await this.deps.loadIndex();
		if (!this.closed) this.index = loaded;
		return loaded;
	}

	/**
	 * Point the controls at whatever is selected now.
	 *
	 * Every await below can be overtaken by another click, so each one is
	 * followed back to the generation it started in. Without that the panel
	 * finishes describing the element he stopped looking at two clicks ago,
	 * which is the state a write must never be sent from.
	 */
	async update(target: KnobsTarget): Promise<void> {
		const mine = ++this.generation;
		const stale = (): boolean => this.closed || mine !== this.generation;

		if (!target.el) return this.hide(mine);
		const name = await this.deps.componentAt(target.el);
		if (stale()) return;
		if (!name) return this.hide(mine);

		const index = await this.ready();
		if (stale()) return;
		const entry = index.components.find((c) => c.name === name) ?? null;
		const knobs = knobsOf(entry);
		if (!entry) return this.hide(mine);
		// Nothing to turn is not news. Almost no component declares `@editor`,
		// so a panel that announced it was announcing the ordinary case on every
		// selection — and it was doing it in the loudest thing on the panel.
		// Absence says it better: no section, no sentence.
		if (knobs.length === 0) return this.hide(mine);

		const pick = pickInstance(entry.instances, target.screenId);
		if (pick.kind === "none") {
			return this.paint(mine, name, null, [], `${name} · 这块屏幕上没有它的调用点`);
		}

		const props = propsOfComponent(this.deps.fiberOf(target.el), name);
		if (pick.kind === "many") {
			const rows = knobs.map((knob) => this.rowOf(knob, props, { writable: false, note: null }));
			return this.paint(
				mine,
				name,
				null,
				rows,
				`这块屏幕上有 ${pick.count} 个 <${entry.aliases[0] ?? name}> 调用点,分不出是哪一个`,
			);
		}

		const at = pick.instance;
		const probes = await this.probeAll(at, knobs);
		if (stale()) return;
		const rows = knobs.map((knob) =>
			this.rowOf(knob, props, probes.get(knob.name) ?? { writable: false, note: null }),
		);
		return this.paint(mine, name, at, rows, null);
	}

	/** One trial write per prop, once per call site. Cached: it cannot change. */
	private async probeAll(
		at: ComponentInstance,
		knobs: KnobSpec[],
	): Promise<Map<string, Probe>> {
		const out = new Map<string, Probe>();
		for (const knob of knobs) {
			const key = probeKey(at, knob.name);
			const known = this.probes.get(key);
			if (known) {
				out.set(knob.name, known);
				continue;
			}
			let probe: Probe;
			try {
				const answer = await this.deps.post({
					file: at.file,
					line: at.line,
					column: at.column,
					tag: at.tag,
					prop: knob.name,
					value: PROBE_VALUE,
				});
				probe = classifyProbe(answer.status, answer.body);
			} catch (error) {
				probe = { writable: false, note: `问不到写不写得进去(${String(error)})` };
			}
			this.probes.set(key, probe);
			out.set(knob.name, probe);
		}
		return out;
	}

	private rowOf(
		knob: KnobSpec,
		props: Record<string, unknown> | null,
		probe: Probe,
	): KnobRow {
		return {
			name: knob.name,
			kind: knob.editor.kind,
			value: displayValue(knob, props ? props[knob.name] : undefined),
			writable: probe.writable,
			note: probe.note,
		};
	}

	private hide(mine: number): void {
		if (this.closed || mine !== this.generation) return;
		this.state = { showing: false, component: null, instance: null, rows: [], warning: null };
		this.root.removeAttribute("data-show");
		this.body.textContent = "";
		this.lead.textContent = "";
		this.warn.textContent = "";
	}

	private paint(
		mine: number,
		component: string,
		instance: ComponentInstance | null,
		rows: KnobRow[],
		warning: string | null,
	): void {
		if (this.closed || mine !== this.generation) return;
		this.state = { showing: true, component, instance, rows, warning };
		this.root.setAttribute("data-show", "");
		// Only when it adds something. Without an instance this said the
		// component's name and nothing else — which the panel's own header has
		// already said, two lines up, in a bigger font.
		this.lead.textContent = instance
			? `${component} · ${instance.file.split("/").pop()}:${instance.line}`
			: "";
		this.warn.textContent = warning ?? "";
		this.render(rows, instance, component);
	}

	private render(rows: KnobRow[], instance: ComponentInstance | null, component: string): void {
		this.body.textContent = "";
		const knobs = this.knobsForRows(rows);
		for (const section of sectionsOf(knobs)) {
			const head = document.createElement("div");
			head.className = "pk-section";
			head.textContent = section.name;
			this.body.appendChild(head);
			for (const knob of section.knobs) {
				const row = rows.find((r) => r.name === knob.name);
				if (row) this.body.appendChild(this.rowEl(knob, row, instance, component));
			}
		}
	}

	/** The specs behind the rows currently shown, in declaration order. */
	private knobsForRows(rows: KnobRow[]): KnobSpec[] {
		const entry = this.index?.components.find((c) => c.name === this.state.component) ?? null;
		const all = knobsOf(entry);
		return all.filter((knob) => rows.some((r) => r.name === knob.name));
	}

	private rowEl(
		knob: KnobSpec,
		row: KnobRow,
		instance: ComponentInstance | null,
		component: string,
	): HTMLElement {
		const wrap = document.createElement("div");
		const line = document.createElement("div");
		line.className = "pk-row";
		line.dataset.prop = knob.name;

		const label = document.createElement("label");
		label.className = "pk-name";
		label.textContent = knob.name;
		line.appendChild(label);

		const readout = document.createElement("span");
		readout.className = "pk-val";

		const control = this.controlEl(knob, row, readout);
		control.className = "pk-ctl";
		control.dataset.prop = knob.name;
		// No instance means we could not tell which call site this is, so there
		// is no tag to write to even when the prop itself would be writable.
		control.disabled = !row.writable || instance === null;
		line.append(control, readout);
		wrap.appendChild(line);

		if (control.disabled && row.note) {
			const why = document.createElement("div");
			why.className = "pk-why";
			why.textContent = row.note;
			wrap.appendChild(why);
		}

		if (!control.disabled && instance) {
			control.addEventListener("change", () => {
				void this.turn(knob, instance, component, this.valueOf(knob, control), row.value);
			});
			if (knob.editor.kind === "range") {
				control.addEventListener("input", () => {
					readout.textContent = this.readoutOf(knob, control.value);
				});
			}
		}
		return wrap;
	}

	private controlEl(
		knob: KnobSpec,
		row: KnobRow,
		readout: HTMLSpanElement,
	): HTMLInputElement | HTMLSelectElement {
		const kind = knob.editor.kind;
		if (kind === "enum") {
			const select = document.createElement("select");
			for (const option of optionsFor(knob)) {
				const el = document.createElement("option");
				el.value = option;
				el.textContent = option;
				select.appendChild(el);
			}
			select.value = String(row.value);
			readout.textContent = "";
			return select;
		}
		const input = document.createElement("input");
		if (kind === "boolean") {
			input.type = "checkbox";
			input.checked = row.value === true;
			readout.textContent = row.value === true ? "true" : "false";
			input.addEventListener("change", () => {
				readout.textContent = input.checked ? "true" : "false";
			});
			return input;
		}
		if (kind === "color") {
			input.type = "color";
			input.value = String(row.value);
			readout.textContent = String(row.value);
			input.addEventListener("input", () => {
				readout.textContent = input.value;
			});
			return input;
		}
		input.type = kind === "range" ? "range" : "number";
		if (knob.editor.min !== undefined) input.min = String(knob.editor.min);
		if (knob.editor.max !== undefined) input.max = String(knob.editor.max);
		input.step = String(knob.editor.step ?? 1);
		input.value = String(row.value);
		readout.textContent = this.readoutOf(knob, input.value);
		return input;
	}

	private readoutOf(knob: KnobSpec, value: string): string {
		return knob.editor.unit ? `${value}${knob.editor.unit}` : value;
	}

	private valueOf(
		knob: KnobSpec,
		control: HTMLInputElement | HTMLSelectElement,
	): string | number | boolean {
		if (knob.editor.kind === "boolean") return (control as HTMLInputElement).checked;
		return control.value;
	}

	/**
	 * One turn: write it, then wait for the screen to show it.
	 *
	 * The write makes vite replace the screen module, so the element the panel
	 * was pointed at goes away. `settle` is the same wait the class edits use,
	 * with the value as the gate rather than the class — the old render is at
	 * the same position and would otherwise be handed back as if it were the
	 * new one.
	 */
	/**
	 * Turn one of the knobs currently on show, by name. The controls call
	 * `turn`; this is the same path for a caller who has no pointer — an agent,
	 * a test — so the two cannot drift.
	 */
	async turnByName(prop: string, raw: string | number | boolean): Promise<void> {
		const instance = this.state.instance;
		const component = this.state.component;
		const row = this.state.rows.find((r) => r.name === prop);
		if (!instance || !component || !row || !row.writable) return;
		const entry = this.index?.components.find((c) => c.name === component) ?? null;
		const knob = knobsOf(entry).find((k) => k.name === prop);
		if (!knob) return;
		await this.turn(knob, instance, component, raw, row.value);
	}

	/**
	 * `previous` is what the control was showing before this turn, and it is a
	 * parameter rather than a read of `this.state` for the same reason the
	 * component name is: the click that turns a knob has already queued the sync
	 * that clears the state, so by the time this runs there is nothing to read.
	 * The row it came from is held by the control's own listener.
	 */
	async turn(
		knob: KnobSpec,
		instance: ComponentInstance,
		component: string,
		raw: string | number | boolean,
		previous: string | number | boolean,
	): Promise<void> {
		// Synchronously, before the first await: the sync() that would drop the
		// selection is already queued by the same click that got us here.
		this.deps.busy(true);
		try {
			await this.write(knob, instance, component, raw, previous);
		} finally {
			this.deps.busy(false);
		}
	}

	private async write(
		knob: KnobSpec,
		instance: ComponentInstance,
		component: string,
		raw: string | number | boolean,
		previous: string | number | boolean,
	): Promise<void> {
		const value = writeFor(knob, raw);
		if (!value) {
			this.warn.textContent = `${knob.name} 不接受 ${String(raw)}`;
			return;
		}
		const post: PropPost = {
			file: instance.file,
			line: instance.line,
			column: instance.column,
			tag: instance.tag,
			prop: knob.name,
			value,
		};
		let answer: PropAnswer;
		try {
			answer = await this.deps.post(post);
		} catch (error) {
			this.warn.textContent = `写不进去(${String(error)})`;
			return;
		}
		// Before the closed check, and deliberately: writing a SCREEN's source
		// makes vite replace the modules this panel lives in, and that teardown
		// arrives while this answer is still in flight. The panel is right to
		// stop touching its own DOM then — but his file has already changed, and
		// a step dropped for that reason is an edit he cannot take back. Found
		// in the running lab: a knob turn on the playground screen rewrote the
		// tag and left the undo stack empty. The stack is not the panel.
		const step = propEditCommand(post, previous, knob, answer.body);
		if (step) pushHistory(step);
		if (this.closed) return;
		if (answer.status !== 200 || answer.body.ok !== true) {
			// The probe said yes and the write said no. Whatever changed since,
			// his source is the authority: take the answer as the new truth,
			// show it, and let the next look rebuild the row disabled.
			const verdict = classifyProbe(answer.status, answer.body);
			this.probes.set(probeKey(instance, knob.name), verdict);
			this.warn.textContent = verdict.note ?? `写不进去(HTTP ${answer.status})`;
			return;
		}
		this.warn.textContent = "";
		// The line numbers of a tag never move when one of its attributes is
		// rewritten, but the index also carries the values, so re-read it.
		this.index = null;
		if (answer.body.changed === false) return;
		const expected = value.value;
		if (typeof expected !== "string" && typeof expected !== "number" && typeof expected !== "boolean") {
			return;
		}
		// The name came in with the turn rather than out of `this.state`: the
		// click that started it has already cleared the selection, so by now the
		// state has been reset and reading the name from it would give null.
		await this.deps.settle((el) =>
			knobLanded(propsOfComponent(this.deps.fiberOf(el), component), knob.name, expected),
		);
	}

	destroy(): void {
		this.closed = true;
		this.root.remove();
	}
}
