import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import { DESIGN_LAB_PORT } from "./design-lab-open.ts";

/** One source of truth for the port; see `resolveLabPort` for why it moved. */
export { DESIGN_LAB_PORT as DEFAULT_LAB_PORT } from "./design-lab-open.ts";

/** Chromium cold start, canvas mount, and the lock-in camera flight. */
const CAPTURE_TIMEOUT_MS = 90_000;
/** Playwright lives in samantha-ui, not in this package's node_modules. */
const PLAYWRIGHT_HOST = join(SAMANTHA_REPO_ROOT, "..", "samantha-ui", "package.json");

export type StillPart = "top" | "bottom";

export interface CaptureRequest {
	screenId: string;
	parts: readonly StillPart[];
	port: number;
}

/** What the scroll-to-tail attempt actually did. `before === after` means the page has no tail. */
export interface ScrollReadout {
	before: number;
	after: number;
	scrollHeight: number;
	clientHeight: number;
}

export interface CaptureResult {
	/** Every screen id found on the canvas — the useful answer when the requested one is absent. */
	screenIds: string[];
	shots: Array<{ part: StillPart; bytes: Buffer }>;
	/** Present once a bottom shot was attempted, so the caller can say why there is only one frame. */
	scroll?: ScrollReadout;
}

/**
 * A frame prepared to ride back in the tool result: the base64 payload plus, when
 * the frame had to be shrunk to fit, the note that maps its coordinates back to
 * the real screen. She measures things off these — a silently scaled frame would
 * make every measurement wrong.
 */
export interface StillImage {
	data: string;
	mimeType: string;
	note?: string;
}

export interface LabStillDeps {
	repoRoot?: string;
	probePort?: (port: number) => Promise<boolean>;
	capture?: (request: CaptureRequest) => Promise<CaptureResult>;
	/** Turns raw PNG bytes into an attachable frame; null means it could not be attached. */
	prepareImage?: (bytes: Buffer) => Promise<StillImage | null>;
}

export function registerLabStillTools(pi: ExtensionAPI, deps: LabStillDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const probePort = deps.probePort ?? probeListeningPort;
	const capture = deps.capture ?? captureWithPlaywright;
	const prepareImage = deps.prepareImage ?? defaultPrepareImage;

	pi.registerTool({
		name: "design_lab_still",
		label: "Design Lab Still",
		description:
			"Photograph one of your design lab screens. The frames come back attached to this result, so you " +
			"see them without opening anything. " +
			"Use it before calling any design done: a screen you have not looked at is not verified, and saying " +
			"it looks right without looking is the one thing that fails a design outright. " +
			"The lab must be open (design_lab_open); if it is not, this skips and tells you — skip is not failure.",
		parameters: Type.Object({
			screenId: Type.String(),
			part: Type.Optional(
				Type.Union([Type.Literal("top"), Type.Literal("bottom"), Type.Literal("both")], {
					description: "Which part of the screen to shoot; 'both' (default) shoots the fold and the tail.",
				}),
			),
			port: Type.Optional(Type.Number()),
		}),
		async execute(_toolCallId, params) {
			const screenId = typeof params.screenId === "string" ? params.screenId.trim() : "";
			if (!screenId)
				return textResult("Missing screenId. Pass the id of the screen you want to look at.", { ok: false });
			if (!/^[a-zA-Z0-9._-]+$/.test(screenId)) {
				return textResult(`Refusing screenId "${screenId}": letters, digits, dot, dash and underscore only.`, {
					ok: false,
				});
			}
			const port = typeof params.port === "number" ? params.port : DESIGN_LAB_PORT;
			const partParam = typeof params.part === "string" ? params.part : "both";
			const parts: StillPart[] = partParam === "both" ? ["top", "bottom"] : [partParam as StillPart];

			if (!(await probePort(port))) {
				return textResult(
					`The design lab is not listening on ${port}, so there is nothing to photograph yet. ` +
						"Open it with design_lab_open and try again. This is a skip, not a failure.",
					{ ok: false, skipped: true, reason: "lab-not-running" },
				);
			}

			let result: CaptureResult;
			try {
				result = await capture({ screenId, parts, port });
			} catch (error) {
				return textResult(`Could not photograph the lab: ${errorText(error)}`, { ok: false });
			}

			if (result.shots.length === 0) {
				const known = result.screenIds.length ? result.screenIds.join(", ") : "(none)";
				return textResult(`No screen with id "${screenId}" is on the canvas. Screens that are: ${known}.`, {
					ok: false,
					screenIds: result.screenIds,
				});
			}

			const paths: string[] = [];
			const frames: Array<{ type: "image"; data: string; mimeType: string }> = [];
			const scaleNotes: string[] = [];
			for (const shot of result.shots) {
				const relative = join("design", "stills", `${screenId}-${shot.part}.png`).replaceAll("\\", "/");
				const absolute = join(repoRoot, relative);
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, shot.bytes);
				paths.push(relative);
				// A frame that cannot be attached still gets written, so the path below is
				// the fallback rather than a dead end.
				let prepared: StillImage | null = null;
				try {
					prepared = await prepareImage(shot.bytes);
				} catch {
					prepared = null;
				}
				if (!prepared) continue;
				frames.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
				if (prepared.note) scaleNotes.push(`${shot.part}: ${prepared.note}`);
			}
			const noTail = result.scroll ? result.scroll.after === result.scroll.before : false;
			const tail = noTail
				? ` This screen does not scroll (content ${result.scroll?.scrollHeight}px, viewport ${result.scroll?.clientHeight}px), so one frame is the whole page and there is no second half to shoot.`
				: "";
			const scale = scaleNotes.length > 0 ? ` ${scaleNotes.join(" ")}` : "";
			const missing =
				frames.length < paths.length
					? ` ${paths.length - frames.length} frame(s) could not be attached; open those from disk.`
					: "";
			const text =
				frames.length > 0
					? `${frames.length} frame(s) of "${screenId}" are attached below — look at them before you call this done.${tail}${scale}${missing} Also saved to ${paths.join(" and ")}.`
					: `Wrote ${paths.join(" and ")}, but could not attach the frame(s) here.${tail} Open and look at them before you call this done.`;
			return {
				content: [{ type: "text" as const, text }, ...frames],
				details: { ok: true, paths, attached: frames.length, scrolls: !noTail, scroll: result.scroll },
			};
		},
	});
}

/**
 * Shrink a frame to what a model will accept, and say by how much. Imported
 * lazily: the resize runs in a worker thread, and nothing should spin one up in
 * a test that never attaches a frame.
 */
async function defaultPrepareImage(bytes: Buffer): Promise<StillImage | null> {
	const { formatDimensionNote, resizeImage } = await import("@earendil-works/pi-coding-agent");
	const resized = await resizeImage(bytes, "image/png");
	if (!resized) return null;
	return { data: resized.data, mimeType: resized.mimeType, note: formatDimensionNote(resized) };
}

/** Vite binds ::1 on this machine, so a v4-only probe reports a live server as dead. */
export function probeListeningPort(port: number, hosts: readonly string[] = ["127.0.0.1", "::1"]): Promise<boolean> {
	return new Promise((resolve) => {
		let pending = hosts.length;
		let settled = false;
		const done = (alive: boolean) => {
			if (settled) return;
			if (alive) {
				settled = true;
				resolve(true);
				return;
			}
			pending -= 1;
			if (pending === 0) {
				settled = true;
				resolve(false);
			}
		};
		for (const host of hosts) {
			const socket = createConnection({ port, host });
			socket.setTimeout(1500);
			socket.once("connect", () => {
				socket.destroy();
				done(true);
			});
			socket.once("timeout", () => {
				socket.destroy();
				done(false);
			});
			socket.once("error", () => {
				socket.destroy();
				done(false);
			});
		}
	});
}

/**
 * Playwright and the DOM globals live in samantha-ui and the browser, not in this
 * package's type world, so the driver is typed structurally and every in-page
 * script is passed as source text.
 */
export interface PageLike {
	goto(url: string, options: Record<string, unknown>): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	evaluate(script: string): Promise<unknown>;
	locator(selector: string): { first(): { count(): Promise<number>; boundingBox(): Promise<Box | null> } };
	mouse: { click(x: number, y: number): Promise<void> };
	keyboard: { press(key: string): Promise<void> };
	screenshot(): Promise<Buffer>;
}
export type Box = { x: number; y: number; width: number; height: number };
export interface BrowserLike {
	newPage(options: Record<string, unknown>): Promise<PageLike>;
	close(): Promise<void>;
}

const COLLECT_SCREEN_IDS = `[...new Set([...document.querySelectorAll("[data-screen-id]")].map((el) => el.getAttribute("data-screen-id") || ""))]`;

/**
 * Open the lab in a fresh chromium page, hand it to `use`, and always close the
 * browser. Every tool that drives the lab goes through here: a second launcher
 * would be a second set of timeouts, a second viewport, and a second thing to
 * remember to close.
 */
export async function withLabPage<T>(port: number, use: (page: PageLike) => Promise<T>): Promise<T> {
	const requireFrom = createRequire(PLAYWRIGHT_HOST);
	const { chromium } = requireFrom("playwright") as {
		chromium: { launch(options: Record<string, unknown>): Promise<BrowserLike> };
	};
	const browser = await chromium.launch({ timeout: CAPTURE_TIMEOUT_MS });
	try {
		const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
		await page.goto(`http://localhost:${port}`, { waitUntil: "networkidle", timeout: CAPTURE_TIMEOUT_MS });
		await page.waitForTimeout(2000);
		return await use(page);
	} finally {
		await browser.close();
	}
}

/** Every screen id on the canvas. */
export async function labScreenIds(page: PageLike): Promise<string[]> {
	return ((await page.evaluate(COLLECT_SCREEN_IDS)) as string[]).filter(Boolean);
}

/** Ask the lab to fly in. Undefined when this lab is too old to have been asked. */
const lockScript = (screenId: string) => `(() => {
  const canvas = window.lab && window.lab.canvas;
  if (!canvas || typeof canvas.lockInto !== "function") return undefined;
  return canvas.lockInto(${JSON.stringify(screenId)});
})()`;

/** Whether that screen's content is live now, read off the DOM rather than believed. */
const lockedInto = (screenId: string) => `(() => {
  const root = document.querySelector("[data-mode]");
  const mode = root ? root.getAttribute("data-mode") : null;
  const group = [...document.querySelectorAll('[data-screen-id="${screenId}"]')]
    .find((el) => el.hasAttribute("data-active"));
  return { mode, active: Boolean(group) };
})()`;

/**
 * The lab's own lock-into-screen camera move. The canvas opens fitted to
 * everything (~20%), where a shot is too small to judge and a point is too
 * coarse to aim. False means the screen did not become live -- either it is not
 * on the canvas, or the lab would not go there.
 *
 * This used to mime the gesture: click the middle of the screen, press Enter.
 * It worked until a sticky note sat in the middle of a screen, and then the
 * click selected the note, Enter did nothing, and this returned true anyway --
 * because it only ever checked that the screen had a box, never that the lab
 * had moved. Everything downstream then hit-tested a canvas at 20% zoom behind
 * an explore-mode shield and truthfully reported that there was nothing there.
 * A canvas is a person's workspace; their notes will be wherever they put them,
 * so a tool cannot aim at pixels and hope.
 *
 * So ask, then look. The gesture stays as the fallback for a lab that predates
 * `window.lab.canvas`, but either way the answer comes from `data-active`.
 */
export async function lockIntoScreen(page: PageLike, screenId: string): Promise<boolean> {
	const target = page.locator(`[data-screen-id="${screenId}"]`).first();
	if ((await target.count()) === 0) return false;

	const asked = (await page.evaluate(lockScript(screenId))) as boolean | undefined;
	if (asked === false) return false;
	if (asked === undefined) {
		const box = await target.boundingBox();
		if (!box) return false;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(300);
		await page.keyboard.press("Enter");
	}
	// The fly-in is animated either way, and the content is not hit-testable
	// until it lands.
	await page.waitForTimeout(2500);
	const state = (await page.evaluate(lockedInto(screenId))) as { mode: string | null; active: boolean };
	return state.active && state.mode !== "explore";
}

const scrollToTail = (screenId: string) =>
	`(() => { const host = document.querySelector('[data-screen-id="${screenId}"] [data-screen-scroll]') || document.querySelector('[data-screen-id="${screenId}"]'); if (!host) return null; const before = host.scrollTop; host.scrollTop = host.scrollHeight; return { before, after: host.scrollTop, scrollHeight: host.scrollHeight, clientHeight: host.clientHeight }; })()`;

async function captureWithPlaywright(request: CaptureRequest): Promise<CaptureResult> {
	return withLabPage(request.port, async (page) => {
		const screenIds = await labScreenIds(page);
		if (!(await lockIntoScreen(page, request.screenId))) return { screenIds, shots: [] };

		const shots: CaptureResult["shots"] = [];
		// Every screen on the canvas fits the 900px host, so none of them scroll. Verify
		// changes here with packages/her/scripts/lab-still-livefire.mjs, which serves a page
		// that does: checking only against the canvas proves one branch and hides the other.
		let scroll: ScrollReadout | undefined;
		for (const part of request.parts) {
			if (part === "bottom") {
				scroll = ((await page.evaluate(scrollToTail(request.screenId))) as ScrollReadout | null) ?? undefined;
				// A page with no tail hands back the same frame. Writing it a second time under
				// another name reads as two pieces of evidence when there is only one.
				if (scroll && scroll.after === scroll.before) {
					if (!shots.some((shot) => shot.part === "top"))
						shots.push({ part: "top", bytes: await page.screenshot() });
					continue;
				}
				await page.waitForTimeout(900);
			}
			shots.push({ part, bytes: await page.screenshot() });
		}
		return { screenIds, shots, scroll };
	});
}

export function errorText(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	if (/Cannot find module 'playwright'/.test(detail)) {
		return "Playwright is not installed where this tool looks for it (samantha-ui). Report this rather than guessing at the picture.";
	}
	return detail;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
