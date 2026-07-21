import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorldNoteData } from "./memory-types.ts";

const execFileAsync = promisify(execFile);

/** palate T2: default tool locations, all overridable via env (see resolveTasteToolConfig). */
const DEFAULT_GRAB_PY_SCRIPT = String.raw`C:\Users\Admin\.claude\skills\media-grabber\scripts\grab.py`;
const DEFAULT_GRAB_PY_PYTHON = "python";
const DEFAULT_AGENT_BROWSER_BIN = "agent-browser";
const DEFAULT_PDFTOTEXT_BIN = "pdftotext";
const DEFAULT_YTDLP_BIN = "yt-dlp";
const GRAB_PY_TIMEOUT_MS = 120_000;
const SCREENSHOT_STEP_TIMEOUT_MS = 45_000;
const PDFTOTEXT_TIMEOUT_MS = 20_000;
const YTDLP_METADATA_TIMEOUT_MS = 20_000;
const SCREENSHOT_VIEWPORT: readonly [width: number, height: number] = [1280, 900];

export type TasteSnapshotKind = "tweet" | "webpage" | "video" | "local-pdf" | "other";

export interface TasteToolConfig {
	agentBrowserBin: string;
	grabPyPython: string;
	grabPyScript: string;
	pdftotextBin: string;
	ytdlpBin: string;
}

export interface TasteSnapshotInput {
	/** absolute path to the original file; required (and only used) for kind "local-pdf". */
	localPath?: string;
	kind: TasteSnapshotKind;
	memoryDir: string;
	slug: string;
	sourceUrl: string;
	tools: TasteToolConfig;
}

export interface TasteSnapshotOutput {
	media: string[];
	screenshot: string | null;
	warnings: string[];
}

/** palate T2: reads the HER_GRAB_PY_..., HER_AGENT_BROWSER_BIN, HER_PDFTOTEXT_BIN, HER_YTDLP_BIN env overrides; falls back to the defaults above. */
export function resolveTasteToolConfig(env: NodeJS.ProcessEnv): TasteToolConfig {
	return {
		agentBrowserBin: env.HER_AGENT_BROWSER_BIN?.trim() || DEFAULT_AGENT_BROWSER_BIN,
		grabPyPython: env.HER_GRAB_PY_PYTHON?.trim() || DEFAULT_GRAB_PY_PYTHON,
		grabPyScript: env.HER_GRAB_PY_SCRIPT?.trim() || DEFAULT_GRAB_PY_SCRIPT,
		pdftotextBin: env.HER_PDFTOTEXT_BIN?.trim() || DEFAULT_PDFTOTEXT_BIN,
		ytdlpBin: env.HER_YTDLP_BIN?.trim() || DEFAULT_YTDLP_BIN,
	};
}

export function resolveTasteMediaRoot(memoryDir: string): string {
	return resolve(memoryDir, "taste-media");
}

/**
 * Resolves `segments` under `root` and rejects any result that escapes it (contract §"路径穿越校验").
 * Mirrors the resolve+relative+".." check her-core/privacy.ts already uses for memory refs.
 */
export function resolveWithinRoot(root: string, ...segments: string[]): string {
	const resolvedRoot = resolve(root);
	const candidate = resolve(resolvedRoot, ...segments);
	const rel = relative(resolvedRoot, candidate);
	if (rel.startsWith("..") || (rel !== "" && resolve(resolvedRoot, rel) !== candidate)) {
		throw new Error(`taste snapshot path escapes its root: ${join(...segments)}`);
	}
	return candidate;
}

/** Captures the media/screenshot half of a taste snapshot; text is handled by the caller. */
export async function captureTasteSnapshot(input: TasteSnapshotInput): Promise<TasteSnapshotOutput> {
	const mediaRoot = resolveTasteMediaRoot(input.memoryDir);
	const warnings: string[] = [];
	if (input.kind === "tweet" || input.kind === "video") {
		const mediaDir = resolveWithinRoot(mediaRoot, input.slug);
		const media = await captureMediaWithGrabPy(input.sourceUrl, mediaDir, mediaRoot, input.tools, warnings);
		return { media, screenshot: null, warnings };
	}
	if (input.kind === "webpage") {
		const screenshotFile = resolveWithinRoot(input.memoryDir, "world", "_snapshots", input.slug, "page.png");
		const screenshot = await captureWebpageScreenshot(
			input.sourceUrl,
			screenshotFile,
			input.memoryDir,
			input.tools,
			warnings,
		);
		return { media: [], screenshot, warnings };
	}
	if (input.kind === "local-pdf") {
		if (!input.localPath) throw new Error("captureTasteSnapshot: kind local-pdf requires localPath");
		const mediaDir = resolveWithinRoot(mediaRoot, input.slug);
		const media = await copyOriginalIntoMedia(input.localPath, mediaDir, mediaRoot, warnings);
		return { media, screenshot: null, warnings };
	}
	return { media: [], screenshot: null, warnings };
}

async function captureMediaWithGrabPy(
	url: string,
	mediaDir: string,
	mediaRoot: string,
	tools: TasteToolConfig,
	warnings: string[],
): Promise<string[]> {
	const existing = await listExistingFiles(mediaDir);
	if (existing.length > 0) return existing.map((name) => toMediaRelativePath(mediaRoot, mediaDir, name));

	await mkdir(mediaDir, { recursive: true });
	try {
		await execFileAsync(tools.grabPyPython, [tools.grabPyScript, url, "--output", mediaDir], {
			timeout: GRAB_PY_TIMEOUT_MS,
		});
	} catch (error) {
		warnings.push(`grab.py media capture failed for ${url}: ${errorMessage(error)}`);
	}
	const files = await listExistingFiles(mediaDir);
	if (files.length === 0) warnings.push(`grab.py produced no media files for ${url}`);
	return files.map((name) => toMediaRelativePath(mediaRoot, mediaDir, name));
}

async function captureWebpageScreenshot(
	url: string,
	screenshotFile: string,
	memoryDir: string,
	tools: TasteToolConfig,
	warnings: string[],
): Promise<string | null> {
	if (await pathExists(screenshotFile)) return toMemoryRelativePath(memoryDir, screenshotFile);

	await mkdir(dirname(screenshotFile), { recursive: true });
	const session = `taste-${createHash("sha256").update(screenshotFile).digest("hex").slice(0, 12)}`;
	const [width, height] = SCREENSHOT_VIEWPORT;
	const runStep = (args: string[]) => runAgentBrowserStep(tools.agentBrowserBin, ["--session", session, ...args]);
	try {
		await runStep(["open", url]);
		await runStep(["set", "viewport", String(width), String(height)]);
		await runStep(["screenshot", "--full", screenshotFile]);
	} catch (error) {
		warnings.push(`agent-browser screenshot capture failed for ${url}: ${errorMessage(error)}`);
	} finally {
		await runAgentBrowserStep(tools.agentBrowserBin, ["--session", session, "close"]).catch(() => undefined);
	}
	if (!(await pathExists(screenshotFile))) {
		warnings.push(`no screenshot file was produced for ${url}`);
		return null;
	}
	return toMemoryRelativePath(memoryDir, screenshotFile);
}

async function runAgentBrowserStep(bin: string, args: string[]): Promise<void> {
	const resolvedBin = resolveExecutableOnPath(bin);
	const plan = await resolveCmdShimSpawnPlan(resolvedBin, args);
	await execFileAsync(plan.command, plan.args, { timeout: SCREENSHOT_STEP_TIMEOUT_MS });
}

/**
 * Resolves a bare command name (e.g. "agent-browser") to its absolute path via `where` so a
 * later .cmd-shim check can find and safely unwrap it. Absolute paths pass through untouched.
 * Mirrors tools/locate.ts's whichPath, duplicated locally to avoid a cross-directory dependency.
 */
function resolveExecutableOnPath(command: string): string {
	if (isAbsolute(command)) return command;
	if (process.platform !== "win32") return command;
	try {
		const out = execFileSync("where", [command], {
			encoding: "utf8",
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const lines = out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		// `where` also lists PATHEXT-less shell shims (e.g. a bare-name bash script); prefer a
		// Windows-executable extension so we don't hand a POSIX script to CreateProcess.
		const executable = lines.find((line) => /\.(cmd|exe|bat)$/i.test(line));
		return executable ?? lines[0] ?? command;
	} catch {
		return command;
	}
}

async function copyOriginalIntoMedia(
	localPath: string,
	mediaDir: string,
	mediaRoot: string,
	warnings: string[],
): Promise<string[]> {
	const destination = resolveWithinRoot(mediaDir, basename(localPath));
	if (await pathExists(destination)) return [toMediaRelativePath(mediaRoot, mediaDir, basename(localPath))];
	await mkdir(mediaDir, { recursive: true });
	try {
		await copyFile(localPath, destination);
	} catch (error) {
		warnings.push(`could not copy original file into taste-media: ${errorMessage(error)}`);
		return [];
	}
	return [toMediaRelativePath(mediaRoot, mediaDir, basename(localPath))];
}

export interface LocalPdfTextResult {
	extracted: string;
	ok: boolean;
	warning?: string;
}

/** palate T2: extracts a PDF's text layer via pdftotext; degrades to a stub, never throws. */
export async function extractLocalPdfText(absolutePath: string, tools: TasteToolConfig): Promise<LocalPdfTextResult> {
	try {
		const { stdout } = await execFileAsync(tools.pdftotextBin, ["-layout", absolutePath, "-"], {
			timeout: PDFTOTEXT_TIMEOUT_MS,
			maxBuffer: 10_000_000,
		});
		const extracted = stdout.trim();
		if (extracted) return { extracted, ok: true };
		return {
			extracted: `(no readable text extracted from PDF: ${absolutePath})`,
			ok: false,
			warning: `pdftotext returned no text for ${absolutePath}`,
		};
	} catch (error) {
		return {
			extracted: `(PDF text layer not extracted: ${errorMessage(error)})`,
			ok: false,
			warning: `pdftotext failed for ${absolutePath}: ${errorMessage(error)}`,
		};
	}
}

/** Builds the WorldNoteData base for a local PDF source, mirroring readPathForWorldNote's shape. */
export function buildLocalPdfTasteData(
	absolutePath: string,
	pdfText: LocalPdfTextResult,
): { data: WorldNoteData; bytesRead: number } {
	const title = basename(absolutePath, extname(absolutePath)).replace(/[-_]+/g, " ") || basename(absolutePath);
	const sourceUrl = `file://${absolutePath.replace(/\\/g, "/")}`;
	const memoryStatus = pdfText.ok ? "active" : "needs_deep_read";
	return {
		bytesRead: Buffer.byteLength(pdfText.extracted, "utf8"),
		data: {
			contentHash: createHash("sha256").update(`${sourceUrl}\n${pdfText.extracted}`).digest("hex"),
			coverage: pdfText.ok
				? `Read the PDF text layer of ${absolutePath} via pdftotext.`
				: `Could not read the PDF text layer of ${absolutePath}: ${pdfText.warning ?? "unknown reason"}.`,
			connections: [],
			extracted: pdfText.extracted,
			memoryStatus,
			...(pdfText.warning ? { memoryStatusReason: pdfText.warning } : {}),
			possibleMoves: pdfText.ok
				? ["Assign this PDF taste card to a board once its theme is clearer."]
				: ["Retry with a working pdftotext install, or extract the text layer manually."],
			read: pdfText.ok
				? "Samantha extracted the PDF's text layer via pdftotext and preserved it as a taste card."
				: "Samantha could not extract this PDF's text layer; only a stub is saved.",
			sourceType: "local-pdf",
			sourceUrl,
			steal: [],
			take: pdfText.ok
				? "Saved through intake-taste so this PDF can be recalled and connected to a board later."
				: "Keep this stub and retry PDF text extraction before relying on it.",
			title,
		},
	};
}

export interface VideoTasteMetadata {
	description?: string;
	ok: boolean;
	title?: string;
	warning?: string;
}

/**
 * palate T2 judgment call (flagged in DECISIONS): grab.py has no metadata-only mode, so a
 * title+description snapshot for video/audio sources needs a second, narrower tool call. Reuses
 * yt-dlp itself (already a transitive dependency of grab.py, not a new provider) with
 * --skip-download; degrades to the caller's existing stub text on any failure.
 */
export async function fetchVideoTasteMetadata(url: string, ytdlpBin: string): Promise<VideoTasteMetadata> {
	try {
		const { stdout } = await execFileAsync(ytdlpBin, ["--dump-json", "--skip-download", "--no-warnings", url], {
			timeout: YTDLP_METADATA_TIMEOUT_MS,
			maxBuffer: 5_000_000,
		});
		const parsed = JSON.parse(stdout) as { description?: unknown; title?: unknown };
		const title = typeof parsed.title === "string" ? parsed.title.trim() : undefined;
		const description = typeof parsed.description === "string" ? parsed.description.trim() : undefined;
		if (!title && !description)
			return { ok: false, warning: `yt-dlp metadata for ${url} had no title or description` };
		return { description, ok: true, title };
	} catch (error) {
		return { ok: false, warning: `yt-dlp metadata fetch failed for ${url}: ${errorMessage(error)}` };
	}
}

const LIST_EXISTING_FILES_MAX_DEPTH = 4;

/**
 * Recursively collects file names (relative to `dir`, forward-slash separated) under `dir`.
 * grab.py nests platform media under subdirectories (e.g. `twitter/<user>/`), so a non-recursive
 * listing sees an empty directory and misreports a fresh capture as having produced no media.
 */
async function listExistingFiles(dir: string, depth = 0): Promise<string[]> {
	if (depth > LIST_EXISTING_FILES_MAX_DEPTH) return [];
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			if (entry.isFile()) {
				results.push(entry.name);
			} else if (entry.isDirectory()) {
				const nested = await listExistingFiles(join(dir, entry.name), depth + 1);
				for (const name of nested) results.push(`${entry.name}/${name}`);
			}
		}
		return results;
	} catch {
		return [];
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function toMediaRelativePath(mediaRoot: string, mediaDir: string, fileName: string): string {
	return toMemoryRelativePath(dirname(mediaRoot), join(mediaDir, fileName));
}

function toMemoryRelativePath(base: string, absolutePath: string): string {
	return relative(resolve(base), absolutePath).split("\\").join("/");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const NPM_CMD_SHIM_TARGET = /"([^"]+)"\s+%\*\s*$/;

/**
 * Duplicated from cli.ts's resolveShellSafeSpawnPlan (her-core cannot import from cli/ without
 * inverting the package's layering). Same technique: on Windows, npm installs CLIs like
 * agent-browser as a .cmd shim; execFile cannot run a .cmd without a shell, and a shell would let
 * an attacker-influenced argv (a URL, a file path) be reinterpreted by cmd.exe's own parser. So we
 * read the shim's own text (developer/install-controlled) and resolve past it to the real script,
 * then run that script directly via node — no shell is ever invoked on untrusted argv.
 */
export async function resolveCmdShimSpawnPlan(
	command: string,
	args: string[],
	nodePath = process.execPath,
): Promise<{ args: string[]; command: string }> {
	if (process.platform !== "win32" || !command.toLowerCase().endsWith(".cmd")) return { args, command };
	const shimText = await readFile(command, "utf8").catch(() => undefined);
	const rawTarget = shimText && NPM_CMD_SHIM_TARGET.exec(shimText)?.[1];
	if (!rawTarget) throw new Error(`could not resolve the script wrapped by cmd shim: ${command}`);
	// npm's cmd-shim generator uses the batch variable %~dp0 (drive+path of the shim itself, which
	// batch semantics always include a trailing backslash); some shims also add a trailing %. Some
	// shims (e.g. agent-browser's) wrap a native .exe directly rather than a .js entry point, so
	// only .js targets get re-run through node.
	const target = resolve(rawTarget.replace(/%~?dp0%?/gi, `${dirname(command)}\\`));
	if (target.toLowerCase().endsWith(".js")) return { command: nodePath, args: [target, ...args] };
	return { command: target, args };
}
