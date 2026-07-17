import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

export type ToolName =
	| "pandoc"
	| "soffice"
	| "ffmpeg"
	| "magick"
	| "tesseract"
	| "7z"
	| "oxipng"
	| "jpegtran"
	| "cwebp"
	| "qpdf"
	| "gswin64c";

export interface ToolLocation {
	tool: ToolName;
	command: string;
	/** Absolute path to the binary, or null when it could not be found. */
	path: string | null;
	/** How to install it when missing (winget line or download guidance). */
	winget: string;
}

/** Finds external binaries. Injected so tests don't depend on what's installed. */
export interface ToolLocator {
	locate(tool: ToolName): ToolLocation;
}

interface KnownTool {
	command: string;
	/** Known install locations (may contain %ENV% and * globs), tried after PATH. */
	candidates: string[];
	winget: string;
}

// Machine-verified locations (2026-07-17). 7-Zip lives on D: under a Chinese,
// space-containing path; several tools sit in versioned dirs matched with * globs.
const KNOWN: Record<ToolName, KnownTool> = {
	pandoc: {
		command: "pandoc",
		candidates: ["%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\JohnMacFarlane.Pandoc_*\\pandoc-*\\pandoc.exe"],
		winget: "winget install --id JohnMacFarlane.Pandoc",
	},
	soffice: {
		command: "soffice",
		candidates: ["C:\\Program Files\\LibreOffice\\program\\soffice.exe"],
		winget: "winget install --id TheDocumentFoundation.LibreOffice",
	},
	ffmpeg: {
		command: "ffmpeg",
		candidates: ["C:\\ffmpeg-*\\bin\\ffmpeg.exe"],
		winget: "winget install --id Gyan.FFmpeg",
	},
	magick: {
		command: "magick",
		candidates: ["C:\\Program Files\\ImageMagick-*\\magick.exe"],
		winget: "winget install --id ImageMagick.ImageMagick",
	},
	tesseract: {
		command: "tesseract",
		candidates: ["C:\\Program Files\\Tesseract-OCR\\tesseract.exe"],
		winget: "winget install --id UB-Mannheim.TesseractOCR",
	},
	"7z": {
		command: "7z",
		candidates: ["D:\\常用软件\\7 zip\\7-Zip\\7z.exe", "C:\\Program Files\\7-Zip\\7z.exe"],
		winget: "winget install --id 7zip.7zip",
	},
	oxipng: {
		command: "oxipng",
		candidates: ["%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\oxipng.exe"],
		winget: "winget install --id Shssoichiro.Oxipng",
	},
	jpegtran: {
		command: "jpegtran",
		candidates: ["C:\\libjpeg-turbo64\\bin\\jpegtran.exe"],
		winget: "winget install --id libjpeg-turbo.libjpeg-turbo.VC",
	},
	cwebp: {
		command: "cwebp",
		candidates: ["%LOCALAPPDATA%\\Microsoft\\WinGet\\Packages\\Google.Libwebp_*\\libwebp-*\\bin\\cwebp.exe"],
		winget: "winget install --id Google.Libwebp",
	},
	qpdf: {
		command: "qpdf",
		candidates: ["C:\\Program Files\\qpdf*\\bin\\qpdf.exe"],
		winget: "winget install --id QPDF.QPDF",
	},
	gswin64c: {
		command: "gswin64c",
		candidates: ["C:\\Program Files\\gs\\gs*\\bin\\gswin64c.exe"],
		winget:
			"Ghostscript 未安装(winget 源已下架)。从 https://github.com/ArtifexSoftware/ghostpdl-downloads/releases 下载官方安装包。",
	},
};

export class SystemToolLocator implements ToolLocator {
	locate(tool: ToolName): ToolLocation {
		const known = KNOWN[tool];
		const onPath = whichPath(known.command);
		if (onPath) return { tool, command: known.command, path: onPath, winget: known.winget };
		for (const candidate of known.candidates) {
			const resolved = globFirst(expandEnv(candidate));
			if (resolved) return { tool, command: known.command, path: resolved, winget: known.winget };
		}
		return { tool, command: known.command, path: null, winget: known.winget };
	}
}

/** Resolve a command through PATH via `where.exe` (the SKILL's first-choice step). */
function whichPath(command: string): string | null {
	try {
		const out = execFileSync("where", [command], {
			encoding: "utf8",
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const first = out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean);
		return first && existsSync(first) ? first : null;
	} catch {
		return null;
	}
}

/** Expand %VAR% references against process.env; leaves unknown vars untouched. */
export function expandEnv(input: string): string {
	return input.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

/**
 * Minimal glob: returns the first existing path matching a pattern whose
 * segments may contain * wildcards (e.g. "C:\\Program Files\\qpdf*\\bin\\qpdf.exe").
 * Wildcard segments are matched case-insensitively; newer names sort first.
 */
export function globFirst(pattern: string): string | null {
	const segments = pattern.split(/[\\/]/).filter((segment, index) => index === 0 || segment.length > 0);
	let bases = [segments[0]];
	for (let i = 1; i < segments.length; i++) {
		const segment = segments[i];
		const next: string[] = [];
		if (segment.includes("*")) {
			const matcher = wildcardToRegExp(segment);
			for (const base of bases) {
				let entries: string[];
				try {
					entries = readdirSync(base);
				} catch {
					continue;
				}
				for (const entry of entries
					.filter((name) => matcher.test(name))
					.sort()
					.reverse()) {
					next.push(joinSegment(base, entry));
				}
			}
		} else {
			for (const base of bases) next.push(joinSegment(base, segment));
		}
		bases = next;
		if (bases.length === 0) return null;
	}
	return bases.find((path) => existsSync(path)) ?? null;
}

function joinSegment(base: string, segment: string): string {
	// base is either a drive ("C:") or an accumulated path; both take a backslash.
	return `${base}\\${segment}`;
}

function wildcardToRegExp(segment: string): RegExp {
	const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}
