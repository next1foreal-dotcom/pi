import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";

const DEFAULT_LAB_PORT = 5180;
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

export interface CaptureResult {
	/** Every screen id found on the canvas — the useful answer when the requested one is absent. */
	screenIds: string[];
	shots: Array<{ part: StillPart; bytes: Buffer }>;
}

export interface LabStillDeps {
	repoRoot?: string;
	probePort?: (port: number) => Promise<boolean>;
	capture?: (request: CaptureRequest) => Promise<CaptureResult>;
}

export function registerLabStillTools(pi: ExtensionAPI, deps: LabStillDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const probePort = deps.probePort ?? probeListeningPort;
	const capture = deps.capture ?? captureWithPlaywright;

	pi.registerTool({
		name: "design_lab_still",
		label: "Design Lab Still",
		description:
			"Photograph one of your design lab screens and get the PNG path back, so you can open it and look. " +
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
			const port = typeof params.port === "number" ? params.port : DEFAULT_LAB_PORT;
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
			for (const shot of result.shots) {
				const relative = join("design", "stills", `${screenId}-${shot.part}.png`).replaceAll("\\", "/");
				const absolute = join(repoRoot, relative);
				await mkdir(dirname(absolute), { recursive: true });
				await writeFile(absolute, shot.bytes);
				paths.push(relative);
			}
			return textResult(`Wrote ${paths.join(" and ")}. Read the image(s) now and look before you call this done.`, {
				ok: true,
				paths,
			});
		},
	});
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
interface PageLike {
	goto(url: string, options: Record<string, unknown>): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	evaluate(script: string): Promise<unknown>;
	locator(selector: string): { first(): { count(): Promise<number>; boundingBox(): Promise<Box | null> } };
	mouse: { click(x: number, y: number): Promise<void> };
	keyboard: { press(key: string): Promise<void> };
	screenshot(): Promise<Buffer>;
}
type Box = { x: number; y: number; width: number; height: number };
interface BrowserLike {
	newPage(options: Record<string, unknown>): Promise<PageLike>;
	close(): Promise<void>;
}

const COLLECT_SCREEN_IDS = `[...new Set([...document.querySelectorAll("[data-screen-id]")].map((el) => el.getAttribute("data-screen-id") || ""))]`;

const scrollToTail = (screenId: string) =>
	`(() => { const host = document.querySelector('[data-screen-id="${screenId}"] [data-screen-scroll]') || document.querySelector('[data-screen-id="${screenId}"]'); if (host) host.scrollTop = host.scrollHeight; })()`;

async function captureWithPlaywright(request: CaptureRequest): Promise<CaptureResult> {
	const requireFrom = createRequire(PLAYWRIGHT_HOST);
	const { chromium } = requireFrom("playwright") as {
		chromium: { launch(options: Record<string, unknown>): Promise<BrowserLike> };
	};
	const browser = await chromium.launch({ timeout: CAPTURE_TIMEOUT_MS });
	try {
		const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
		await page.goto(`http://localhost:${request.port}`, { waitUntil: "networkidle", timeout: CAPTURE_TIMEOUT_MS });
		await page.waitForTimeout(2000);

		const screenIds = ((await page.evaluate(COLLECT_SCREEN_IDS)) as string[]).filter(Boolean);
		const target = page.locator(`[data-screen-id="${request.screenId}"]`).first();
		if ((await target.count()) === 0) return { screenIds, shots: [] };

		// The canvas opens fitted to everything (~24%), where a shot is too small to judge.
		// Clicking the screen and pressing Enter is the lab's own lock-into-screen camera move.
		const box = await target.boundingBox();
		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			await page.waitForTimeout(300);
			await page.keyboard.press("Enter");
			await page.waitForTimeout(2500);
		}

		const shots: CaptureResult["shots"] = [];
		for (const part of request.parts) {
			if (part === "bottom") {
				await page.evaluate(scrollToTail(request.screenId));
				await page.waitForTimeout(900);
			}
			shots.push({ part, bytes: await page.screenshot() });
		}
		return { screenIds, shots };
	} finally {
		await browser.close();
	}
}

function errorText(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	if (/Cannot find module 'playwright'/.test(detail)) {
		return "Playwright is not installed where this tool looks for it (samantha-ui). Report this rather than guessing at the picture.";
	}
	return detail;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
