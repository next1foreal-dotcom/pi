import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import {
	DEFAULT_LAB_PORT,
	errorText,
	labScreenIds,
	lockIntoScreen,
	type PageLike,
	probeListeningPort,
	withLabPage,
} from "./lab-still.ts";

/**
 * Point at a rendered element, then change the class list of the JSX tag that
 * made it.
 *
 * The reading half (`design_element_at`) is the mouse she does not have: the
 * inspect plugin already turns a point into a source location, but only a person
 * shift-clicking in a browser could ever supply the point. This drives the same
 * published api through the same Playwright plumbing `design_lab_still` uses.
 *
 * The writing half (`design_element_classes`) is worth more for what it refuses
 * than for what it writes. A source location goes stale the instant anything
 * edits the file, and in a screen with six buttons the wrong line looks exactly
 * as plausible as the right one. So it re-opens the file, walks to that line and
 * column, and only writes if the tag standing there is still the tag the caller
 * says it selected. A `className={...}` expression is refused by name rather
 * than guessed at, because no amount of textual cleverness makes editing
 * `cn(base, active && "x")` correct.
 */

import { EDITABLE_SOURCE, editClassList, splitClasses } from "./jsx-class-list.ts";

export {
	type ClassEditRequest,
	type ClassEditResult,
	type ClassListProblem,
	describeExpression,
	editClassList,
	findOpeningTag,
	scanAttributes,
} from "./jsx-class-list.ts";

/** What `design_element_at` learned about one point on one screen. */
export interface PickResult {
	/** Every screen id on the canvas — the useful answer when the requested one is absent. */
	screenIds: string[];
	/** The named screen is on the canvas. */
	found: boolean;
	/** The inspect plugin is not published on `window.lab`. */
	labless?: boolean;
	/** The point is outside the browser viewport even after scrolling to it. */
	offscreen?: boolean;
	selection: LabSelection | null;
	geometry?: PickGeometry;
	/** The selected element's box, in the same screen-relative units as the point. */
	box?: { x: number; y: number; width: number; height: number };
}

/** The inspect plugin's answer. Mirrors `InspectSelection` without importing across packages. */
export interface LabSelection {
	screenId: string | null;
	file: string | null;
	line: number | null;
	column: number | null;
	component: string | null;
	tag: string;
	className: string;
	text: string;
	attached: boolean;
	problem: string | null;
}

export interface PickGeometry {
	/** The screen's own layout size, and how far its content runs. */
	screen: { width: number; height: number; scrollWidth: number; scrollHeight: number };
	point: { x: number; y: number };
	client: { x: number; y: number };
	/** Canvas zoom at the moment of the hit test. */
	scale: number;
	scroll: { top: number; left: number };
	viewport: { width: number; height: number };
}

export interface PickRequest {
	screenId: string;
	x: number;
	y: number;
	port: number;
}

export interface ElementEditDeps {
	repoRoot?: string;
	probePort?: (port: number) => Promise<boolean>;
	pick?: (request: PickRequest) => Promise<PickResult>;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

/** Repo-relative `.tsx`/`.jsx` inside the repo, or the reason it is not. */
export function resolveSourcePath(
	repoRoot: string,
	file: string,
): { ok: true; absolute: string; relative: string } | { ok: false; reason: string } {
	const raw = file.trim();
	if (!raw) return { ok: false, reason: "Missing file. Pass the repo-relative path design_element_at gave you." };
	const absolute = resolve(repoRoot, raw.replaceAll("\\", "/"));
	const rel = relative(repoRoot, absolute).replaceAll("\\", "/");
	if (rel === "" || rel.startsWith("../") || isAbsolute(rel)) {
		return { ok: false, reason: `Refusing ${raw}: it resolves outside the repo.` };
	}
	if (!EDITABLE_SOURCE.test(rel)) {
		return { ok: false, reason: `Refusing ${rel}: this edits JSX tags, so it only opens .tsx and .jsx files.` };
	}
	return { ok: true, absolute, relative: rel };
}

/**
 * Hit-test one point and select what is under it, using the inspect plugin's own
 * published api.
 *
 * `selectAt` takes PAGE units, which need the canvas camera and origin — and
 * `window.lab` publishes neither. `selectElement` over `elementsFromPoint` is
 * what `selectAt` does internally once it has converted, so this reaches the
 * same element by the same route, from coordinates the browser can give us.
 *
 * The point is relative to the screen's scroller, in the screen's own layout
 * pixels, so it stays the same number at any canvas zoom and below the fold.
 */
const pickScript = (screenId: string, x: number, y: number) => `(() => {
  const out = { screenIds: [], found: false, selection: null };
  out.screenIds = [...new Set([...document.querySelectorAll("[data-screen-id]")].map((el) => el.getAttribute("data-screen-id") || ""))].filter(Boolean);
  const screen = document.querySelector('[data-screen-id="${screenId}"]');
  if (!screen) return out;
  out.found = true;
  const api = window.lab && typeof window.lab.plugin === "function" ? window.lab.plugin("inspect") : null;
  if (!api || typeof api.selectElement !== "function") { out.labless = true; return out; }
  const scroller = screen.querySelector("[data-screen-scroll]") || screen;
  const layout = scroller.offsetWidth;
  const scale = layout > 0 ? scroller.getBoundingClientRect().width / layout : 0;
  if (!(scale > 0)) { out.labless = true; return out; }
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxTop > 0) scroller.scrollTop = Math.min(maxTop, Math.max(0, ${y} - scroller.clientHeight / 2));
  if (maxLeft > 0) scroller.scrollLeft = Math.min(maxLeft, Math.max(0, ${x} - scroller.clientWidth / 2));
  const rect = scroller.getBoundingClientRect();
  const cx = rect.left + (${x} - scroller.scrollLeft) * scale;
  const cy = rect.top + (${y} - scroller.scrollTop) * scale;
  out.geometry = {
    screen: { width: layout, height: scroller.offsetHeight, scrollWidth: scroller.scrollWidth, scrollHeight: scroller.scrollHeight },
    point: { x: ${x}, y: ${y} },
    client: { x: cx, y: cy },
    scale: scale,
    scroll: { top: scroller.scrollTop, left: scroller.scrollLeft },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) { out.offscreen = true; return out; }
  let node = null;
  for (const el of document.elementsFromPoint(cx, cy)) {
    const sel = api.selectElement(el);
    if (sel) { out.selection = sel; node = el; break; }
  }
  if (!node) { if (typeof api.clear === "function") api.clear(); return out; }
  const br = node.getBoundingClientRect();
  out.box = {
    x: (br.left - rect.left) / scale + scroller.scrollLeft,
    y: (br.top - rect.top) / scale + scroller.scrollTop,
    width: br.width / scale,
    height: br.height / scale,
  };
  return out;
})()`;

async function pickWithPlaywright(request: PickRequest): Promise<PickResult> {
	return withLabPage(request.port, async (page: PageLike) => {
		const screenIds = await labScreenIds(page);
		if (!(await lockIntoScreen(page, request.screenId))) return { screenIds, found: false, selection: null };
		const raw = (await page.evaluate(pickScript(request.screenId, request.x, request.y))) as PickResult;
		return { ...raw, screenIds: raw.screenIds?.length ? raw.screenIds : screenIds };
	});
}

function describeSelection(selection: LabSelection, box: PickResult["box"]): string {
	const where =
		selection.file && selection.line !== null && selection.column !== null
			? `${selection.file}:${selection.line}:${selection.column}`
			: `source unknown (${selection.problem ?? "no location"})`;
	const owner = selection.component ? ` rendered by ${selection.component}` : "";
	const classes = selection.className ? `class "${selection.className}"` : "no class attribute";
	const at = box
		? ` It sits at ${Math.round(box.x)},${Math.round(box.y)} and is ${Math.round(box.width)}×${Math.round(box.height)} in the same screen units you aimed with.`
		: "";
	const sample = selection.text ? ` Its text reads "${selection.text}".` : "";
	return `<${selection.tag}>${owner} at ${where}, with ${classes}.${sample}${at}`;
}

export function registerElementEditTools(pi: ExtensionAPI, deps: ElementEditDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const probePort = deps.probePort ?? probeListeningPort;
	const pick = deps.pick ?? pickWithPlaywright;

	pi.registerTool({
		name: "design_element_at",
		label: "Design Element At",
		description:
			"Point at something on one of your design lab screens and learn which line of JSX made it. " +
			"This is the mouse you do not have: a person gets here by shift-clicking, you get here by naming a point. " +
			"x and y are relative to the screen's top-left in the screen's OWN layout pixels — the same numbers as its " +
			"design width — not pixels measured off a design_lab_still frame, which is the browser viewport at 2x. " +
			"The answer names the file, line and column of the tag, plus the element's box in those same units, so you " +
			"can aim at a neighbour without guessing. Feed file/line/column/tag straight into design_element_classes. " +
			"The lab must be open (design_lab_open); if it is not, this skips and tells you — skip is not failure.",
		parameters: Type.Object({
			screenId: Type.String(),
			x: Type.Number(),
			y: Type.Number(),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params) {
			const screenId = typeof params.screenId === "string" ? params.screenId.trim() : "";
			if (!screenId)
				return textResult("Missing screenId. Pass the id of the screen you want to point at.", { ok: false });
			if (!/^[a-zA-Z0-9._-]+$/.test(screenId)) {
				return textResult(`Refusing screenId "${screenId}": letters, digits, dot, dash and underscore only.`, {
					ok: false,
				});
			}
			const x = typeof params.x === "number" ? params.x : Number.NaN;
			const y = typeof params.y === "number" ? params.y : Number.NaN;
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				return textResult(
					"Missing x or y. Pass a point relative to the screen's top-left, in its own layout pixels.",
					{
						ok: false,
					},
				);
			}
			const port = typeof params.port === "number" ? params.port : DEFAULT_LAB_PORT;

			if (!(await probePort(port))) {
				return textResult(
					`The design lab is not listening on ${port}, so there is nothing to point at yet. ` +
						"Open it with design_lab_open and try again. This is a skip, not a failure.",
					{ ok: false, skipped: true, reason: "lab-not-running" },
				);
			}

			let result: PickResult;
			try {
				result = await pick({ screenId, x, y, port });
			} catch (error) {
				return textResult(`Could not point at the lab: ${errorText(error)}`, { ok: false });
			}

			if (!result.found) {
				const known = result.screenIds.length ? result.screenIds.join(", ") : "(none)";
				return textResult(`No screen with id "${screenId}" is on the canvas. Screens that are: ${known}.`, {
					ok: false,
					screenIds: result.screenIds,
				});
			}
			if (result.labless) {
				return textResult(
					"The inspect plugin is not published on window.lab, so nothing can resolve a point to source. " +
						"The lab is running but its plugins have not mounted; reload it and try again.",
					{ ok: false, reason: "no-inspect-plugin" },
				);
			}
			const g = result.geometry;
			if (result.offscreen) {
				return textResult(
					`(${x}, ${y}) is off the browser viewport even after scrolling the screen to it. ` +
						(g
							? `The screen is ${Math.round(g.screen.width)}×${Math.round(g.screen.height)} with content running to ${Math.round(g.screen.scrollHeight)}, ` +
								`and the canvas is at ${g.scale.toFixed(2)}x. Aim inside that.`
							: ""),
					{ ok: false, reason: "point-offscreen", geometry: g },
				);
			}
			if (!result.selection) {
				return textResult(
					`Nothing selectable at (${x}, ${y}) on "${screenId}". ` +
						(g
							? `The screen is ${Math.round(g.screen.width)}×${Math.round(g.screen.height)}, content runs to ${Math.round(g.screen.scrollHeight)}. `
							: "") +
						"Lab chrome, sticky notes, labels, rulers and the scroller itself are never hit — aim at content.",
					{ ok: false, reason: "nothing-there", geometry: g },
				);
			}

			return textResult(describeSelection(result.selection, result.box), {
				ok: true,
				selection: result.selection,
				box: result.box,
				geometry: g,
			});
		},
	});

	pi.registerTool({
		name: "design_element_classes",
		label: "Design Element Classes",
		description:
			"Change the class list of ONE JSX tag, at the file/line/column design_element_at gave you. " +
			"Pass the tag you selected: this re-opens the file and refuses to write unless that tag is still standing at " +
			"that line and column, because a location goes stale the moment anything edits the file and editing the wrong " +
			"element of six is worse than editing none. " +
			"add and remove adjust the list in place and leave everything else byte-for-byte; replace rewrites the whole " +
			"list and has to be asked for by name. A className={...} expression — cn(...), a template literal, a " +
			"conditional — is refused and named, never guessed at. " +
			"Writing the file triggers the lab's hot reload, so the next design_lab_still shows the change: take one, " +
			"because a change you have not looked at is not verified.",
		parameters: Type.Object({
			file: Type.String(),
			line: Type.Number(),
			column: Type.Number(),
			tag: Type.String(),
			add: Type.Optional(Type.String()),
			remove: Type.Optional(Type.String()),
			replace: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			const path = resolveSourcePath(repoRoot, typeof params.file === "string" ? params.file : "");
			if (!path.ok) return textResult(path.reason, { ok: false });

			const line = typeof params.line === "number" ? params.line : Number.NaN;
			const column = typeof params.column === "number" ? params.column : Number.NaN;
			const tag = typeof params.tag === "string" ? params.tag.trim() : "";
			if (!Number.isFinite(line) || !Number.isFinite(column) || !tag) {
				return textResult(
					"Missing line, column or tag. All three come from design_element_at, and the tag is what makes a stale " +
						"location refusable rather than silently wrong.",
					{ ok: false },
				);
			}

			const add = splitClasses(params.add);
			const remove = splitClasses(params.remove);
			const wantsReplace = typeof params.replace === "string" && params.replace.trim() !== "";
			const replace = wantsReplace ? splitClasses(params.replace) : undefined;
			if (replace && (add.length > 0 || remove.length > 0)) {
				return textResult(
					"replace rewrites the whole class list, so it cannot be combined with add or remove. Send one or the other.",
					{ ok: false },
				);
			}
			if (!replace && add.length === 0 && remove.length === 0) {
				return textResult("Nothing to change. Pass add, remove, or replace.", { ok: false });
			}

			let source: string;
			try {
				source = await readFile(path.absolute, "utf8");
			} catch (error) {
				return textResult(`Could not read ${path.relative}: ${errorText(error)}`, { ok: false });
			}

			const edit = editClassList(source, { line, column, tag, add, remove, replace });
			if (!edit.ok) {
				return textResult(`Refusing to edit ${path.relative}: ${edit.reason}`, {
					ok: false,
					problem: edit.problem,
					file: path.relative,
				});
			}
			if (!edit.changed) {
				return textResult(
					`<${tag}> at ${path.relative}:${line} already reads "${edit.before}" — nothing to do. ` +
						(edit.present.length ? `Already there: ${edit.present.join(", ")}. ` : "") +
						(edit.missing.length ? `Not on the tag: ${edit.missing.join(", ")}.` : ""),
					{ ok: true, changed: false, file: path.relative, className: edit.before },
				);
			}

			try {
				await writeFile(path.absolute, edit.source);
			} catch (error) {
				return textResult(`Could not write ${path.relative}: ${errorText(error)}`, { ok: false });
			}

			const notes =
				(edit.present.length ? ` Already there: ${edit.present.join(", ")}.` : "") +
				(edit.missing.length ? ` Not on the tag, so not removed: ${edit.missing.join(", ")}.` : "");
			const became = edit.dropped
				? `has no className at all now (it was "${edit.before}") — an empty class list is not a class list, so the attribute came off with the last name in it`
				: `now reads class "${edit.after}" (was "${edit.before}")`;
			return textResult(
				`<${tag}> at ${path.relative}:${line}:${column} ${became}.${notes} ` +
					"The lab hot-reloads on this write — take a design_lab_still and look at it.",
				{
					ok: true,
					changed: true,
					file: path.relative,
					before: edit.before,
					after: edit.after,
					dropped: edit.dropped,
				},
			);
		},
	});
}
