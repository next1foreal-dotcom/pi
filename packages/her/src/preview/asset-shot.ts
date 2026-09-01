import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import { probeListeningPort } from "./lab-still.ts";

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 900;
const CAPTURE_TIMEOUT_MS = 90_000;
/** Playwright lives in samantha-ui, not in this package's node_modules. */
const PLAYWRIGHT_HOST = join(SAMANTHA_REPO_ROOT, "..", "samantha-ui", "package.json");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export interface AssetCaptureRequest {
	url: string;
	width: number;
	height: number;
	settleMs: number;
}

export interface AssetShotDeps {
	repoRoot?: string;
	now?: () => string;
	probePort?: (port: number) => Promise<boolean>;
	capture?: (request: AssetCaptureRequest) => Promise<Buffer>;
}

export function registerAssetShotTools(pi: ExtensionAPI, deps: AssetShotDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const now = deps.now ?? (() => new Date().toISOString());
	const probePort = deps.probePort ?? probeListeningPort;
	const capture = deps.capture ?? captureWithPlaywright;

	pi.registerTool({
		name: "design_asset_shot",
		label: "Design Asset Shot",
		description:
			"Photograph a locally running app into a real asset you can place in a design. " +
			"For a product page the product IS the hero asset: run the real thing, shoot it, and put that frame " +
			"in the page instead of a gray box. Saves the PNG plus a receipt naming the source URL and the moment " +
			"it was taken — an asset whose origin you cannot state does not belong in a design. Local targets only.",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL of a locally running app, e.g. http://localhost:5173" }),
			name: Type.String({ description: "asset name, used as the file name" }),
			width: Type.Optional(Type.Number()),
			height: Type.Optional(Type.Number()),
			settleMs: Type.Optional(Type.Number({ description: "extra wait after load, for apps that animate in" })),
		}),
		async execute(_toolCallId, params) {
			const name = typeof params.name === "string" ? params.name.trim() : "";
			if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
				return textResult(
					`Refusing asset name "${name}": letters, digits, dot, dash and underscore only, and not empty.`,
					{ ok: false },
				);
			}
			const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
			const target = parseLocalHttpUrl(rawUrl);
			if (!target) {
				return textResult(
					`Refusing "${rawUrl}". This tool shoots a locally running app over http(s) — ` +
						"run the thing you want a picture of, then point at it.",
					{ ok: false },
				);
			}
			const width = numberOr(params.width, DEFAULT_WIDTH);
			const height = numberOr(params.height, DEFAULT_HEIGHT);
			const settleMs = numberOr(params.settleMs, 1500);

			const port = target.port ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
			if (!(await probePort(port))) {
				return textResult(
					`Nothing is listening on ${target.host}, so there is nothing to photograph. ` +
						"Start the app first, then shoot it. This is a skip, not a failure.",
					{ ok: false, skipped: true, reason: "target-not-running" },
				);
			}

			let bytes: Buffer;
			try {
				bytes = await capture({ url: target.toString(), width, height, settleMs });
			} catch (error) {
				return textResult(`Could not photograph ${target.host}: ${errorText(error)}`, { ok: false });
			}

			const relative = `design/assets/${name}.png`;
			const absolute = join(repoRoot, relative);
			await mkdir(dirname(absolute), { recursive: true });
			await writeFile(absolute, bytes);
			// The receipt: an asset nobody can trace is a liability in a design review.
			await writeFile(
				join(repoRoot, `design/assets/${name}.json`),
				`${JSON.stringify({ url: target.toString(), capturedAt: now(), width, height }, null, "\t")}\n`,
			);

			return textResult(
				`Wrote ${relative} (${bytes.length} bytes) with a receipt naming ${target.toString()}. ` +
					"Look at it before you place it — a frame that does not show the product doing its thing is still a gray box.",
				{ ok: true, path: relative, url: target.toString() },
			);
		},
	});
}

function parseLocalHttpUrl(raw: string): URL | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) return undefined;
	return url;
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface PageLike {
	goto(url: string, options: Record<string, unknown>): Promise<unknown>;
	waitForTimeout(ms: number): Promise<void>;
	screenshot(): Promise<Buffer>;
}
interface BrowserLike {
	newPage(options: Record<string, unknown>): Promise<PageLike>;
	close(): Promise<void>;
}

async function captureWithPlaywright(request: AssetCaptureRequest): Promise<Buffer> {
	const requireFrom = createRequire(PLAYWRIGHT_HOST);
	const { chromium } = requireFrom("playwright") as {
		chromium: { launch(options: Record<string, unknown>): Promise<BrowserLike> };
	};
	const browser = await chromium.launch({ timeout: CAPTURE_TIMEOUT_MS });
	try {
		const page = await browser.newPage({
			viewport: { width: request.width, height: request.height },
			deviceScaleFactor: 2,
		});
		await page.goto(request.url, { waitUntil: "networkidle", timeout: CAPTURE_TIMEOUT_MS });
		await page.waitForTimeout(request.settleMs);
		return await page.screenshot();
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
