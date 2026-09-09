import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
import { DESIGN_LAB_PORT } from "./design-lab-open.ts";
import { errorText, labScreenIds, lockIntoScreen, type PageLike, withLabPage } from "./lab-still.ts";

/** Where an export lands. Derived output, so it is regenerated rather than versioned. */
export const EXPORT_DIR = join("design", "exports");

export type ExportFormat = "png" | "pdf";

export interface ExportRequest {
	screenIds: readonly string[];
	format: ExportFormat;
	port: number;
}

export interface ExportedShot {
	screenId: string;
	bytes: Buffer;
}

export interface ExportResult {
	/** Every screen on the canvas, so a typo answers with the list instead of nothing. */
	screenIds: string[];
	shots: ExportedShot[];
	/** Present only for the pdf format, and only when at least one screen was shot. */
	pdf?: Buffer;
}

export interface LabExportDeps {
	repoRoot?: string;
	capture?: (request: ExportRequest) => Promise<ExportResult>;
	now?: () => Date;
}

/**
 * Which screens this run is about, and which asked-for names do not exist.
 *
 * Asking for nothing means the whole canvas — that is what "export the designs"
 * means when nobody named one. A name that is not on the canvas is reported
 * rather than silently dropped: a PDF that is quietly missing a page is worse
 * than a refusal, because it looks complete.
 */
export function chooseScreens(
	found: readonly string[],
	requested: readonly string[],
): { take: string[]; missing: string[] } {
	if (requested.length === 0) return { take: [...found], missing: [] };
	const take: string[] = [];
	const missing: string[] = [];
	for (const id of requested) {
		if (found.includes(id)) take.push(id);
		else missing.push(id);
	}
	return { take, missing };
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
	);
}

/**
 * One screen per page, nothing else on it.
 *
 * No caption, no header, no page number. This is the file he hands to someone;
 * anything stamped over the design is a thing he then has to explain away. The
 * page order is reported in the tool's answer instead, where it costs nothing.
 *
 * The images are embedded as data URIs because the page is loaded with
 * `setContent` and has no origin to resolve a file path against.
 */
export function pdfHtml(shots: readonly ExportedShot[]): string {
	const pages = shots
		.map(
			(shot) =>
				`<figure><img alt="${escapeHtml(shot.screenId)}" src="data:image/png;base64,${shot.bytes.toString("base64")}"></figure>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8"><style>
@page { margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
figure { margin: 0; break-after: page; page-break-after: always }
figure:last-of-type { break-after: auto; page-break-after: auto }
img { display: block; width: 100%; height: auto }
</style></head><body>${pages}</body></html>`;
}

/** `<screen>.png`, and one pdf named for the run. Both plain enough to guess at. */
export function exportFileName(format: ExportFormat, screenId: string, name: string): string {
	return format === "png" ? `${screenId}.png` : `${name}.pdf`;
}

/** A screen id, safe to sit inside a double-quoted CSS attribute selector. */
export function cssAttrValue(value: string): string {
	return value.replace(/["\\]/g, (c) => `\\${c}`);
}

/**
 * The frame, without the lab around it.
 *
 * A whole-viewport shot is what `design_lab_still` wants — she needs to see the
 * canvas she is standing on. An export is the opposite: it is the file he hands
 * to someone, and the first live-fire came back with the screen name, the run
 * button, the "esc exits" badge and the whole zoom HUD printed around his design.
 * Valid PNG, passing tests, wrong picture. Shooting the frame element crops all
 * of it, and the sticky notes with it — they live in a sibling host layer, so
 * they are not children of the frame and cannot end up in an export.
 *
 * Falls back to the viewport when the driver has no element screenshot, which is
 * every fake page in a test.
 */
async function shootFrame(page: PageLike, screenId: string): Promise<Buffer> {
	const frame = page.locator(`[data-screen-id="${cssAttrValue(screenId)}"]`).first();
	if (frame.screenshot && (await frame.count()) > 0) return frame.screenshot();
	return page.screenshot();
}

async function exportWithPlaywright(request: ExportRequest): Promise<ExportResult> {
	return withLabPage(request.port, async (page: PageLike) => {
		const screenIds = await labScreenIds(page);
		const { take } = chooseScreens(screenIds, request.screenIds);

		const shots: ExportedShot[] = [];
		for (const screenId of take) {
			if (!(await lockIntoScreen(page, screenId))) continue;
			shots.push({ screenId, bytes: await shootFrame(page, screenId) });
		}

		if (request.format !== "pdf" || shots.length === 0) return { screenIds, shots };

		// The same page, after every shot is taken. Printing has to happen in a
		// chromium page and this is the one we already have; navigating it away
		// from the lab at the very end costs nothing, because the browser closes
		// on the next line either way.
		if (!page.setContent || !page.pdf) {
			throw new Error("This chromium page cannot print; the pdf outlet needs setContent and pdf.");
		}
		await page.setContent(pdfHtml(shots), { waitUntil: "load" });
		// The viewport is 1500x1000 CSS px at deviceScaleFactor 2, so a page of
		// exactly that size prints one screen at 1:1 rather than reflowed to A4.
		const pdf = await page.pdf({
			width: "1500px",
			height: "1000px",
			printBackground: true,
			margin: { top: "0", right: "0", bottom: "0", left: "0" },
		});
		return { screenIds, shots, pdf };
	});
}

export function registerLabExportTools(pi: ExtensionAPI, deps: LabExportDeps = {}): void {
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const capture = deps.capture ?? exportWithPlaywright;
	const now = deps.now ?? (() => new Date());

	pi.registerTool({
		name: "design_lab_export",
		label: "Design Lab Export",
		description:
			"Write your design lab screens out as files he can open, send, or print — PNG per screen, or " +
			"one PDF with a screen per page. This is not design_lab_still: that one hands you a frame to " +
			"look at, this one leaves a file on disk and hands you back its path. Use it when a design is " +
			"settled and he needs it outside the lab. Naming no screen exports the whole canvas, in canvas " +
			"order. A screen name that is not on the canvas is named back to you rather than quietly " +
			"skipped, because a PDF missing a page still looks complete.",
		parameters: Type.Object({
			screenIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "Screens to export. Omit for every screen on the canvas.",
				}),
			),
			format: Type.Optional(
				Type.Union([Type.Literal("png"), Type.Literal("pdf")], {
					description: 'One file per screen ("png", the default) or one file of pages ("pdf").',
				}),
			),
			name: Type.Optional(
				Type.String({ description: 'Base name for the pdf. Defaults to the date, e.g. "canvas-2026-09-09".' }),
			),
			port: Type.Optional(Type.Number({ description: "The lab's port. Defaults to the one it is started on." })),
		}),
		async execute(
			_toolCallId,
			params: { screenIds?: string[]; format?: ExportFormat; name?: string; port?: number },
		) {
			const format: ExportFormat = params.format === "pdf" ? "pdf" : "png";
			const port = typeof params.port === "number" ? params.port : DESIGN_LAB_PORT;
			const requested = params.screenIds ?? [];
			const name = params.name?.trim() || `canvas-${now().toISOString().slice(0, 10)}`;

			let result: ExportResult;
			try {
				result = await capture({ screenIds: requested, format, port });
			} catch (error) {
				return textResult(`Could not export: ${errorText(error)}`, { ok: false });
			}

			const { missing } = chooseScreens(result.screenIds, requested);
			if (result.shots.length === 0) {
				return textResult(
					`Nothing exported. The canvas has ${result.screenIds.length === 0 ? "no screens" : `these screens: ${result.screenIds.join(", ")}`}.`,
					{ ok: false, screenIds: result.screenIds, missing },
				);
			}

			const dir = join(repoRoot, EXPORT_DIR);
			await mkdir(dir, { recursive: true });
			const written: string[] = [];
			if (format === "pdf") {
				if (!result.pdf) {
					return textResult("The screens were captured but no pdf came back.", { ok: false });
				}
				const file = exportFileName("pdf", "", name);
				await writeFile(join(dir, file), result.pdf);
				written.push(file);
			} else {
				for (const shot of result.shots) {
					const file = exportFileName("png", shot.screenId, name);
					await writeFile(join(dir, file), shot.bytes);
					written.push(file);
				}
			}

			const order = result.shots.map((shot) => shot.screenId);
			const lines = [
				`Wrote ${written.length} file${written.length === 1 ? "" : "s"} to ${EXPORT_DIR}:`,
				...written.map((file) => `- ${file}`),
			];
			if (format === "pdf") lines.push(`Pages, in order: ${order.join(", ")}.`);
			if (missing.length > 0) {
				lines.push(`Not on the canvas, so not exported: ${missing.join(", ")}.`);
			}
			return textResult(lines.join("\n"), {
				ok: true,
				format,
				files: written,
				screens: order,
				missing,
				dir: EXPORT_DIR,
			});
		},
	});
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}
