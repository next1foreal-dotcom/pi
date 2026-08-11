import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const secretPatterns = [
	/sk-[A-Za-z0-9]{20,}/g,
	/api[_-]?key\s*[:=]\s*\S+/gi,
	/ghp_\w+/g,
	/AIza\w+/g,
	/Bearer\s+\S+/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): string {
	let redacted = text;
	for (const pattern of secretPatterns) {
		redacted = redacted.replace(pattern, "«REDACTED:secret»");
	}
	return redacted;
}

export function findSecretMatches(text: string): Array<{ index: number; patternIndex: number }> {
	const matches: Array<{ index: number; patternIndex: number }> = [];
	for (const [patternIndex, pattern] of secretPatterns.entries()) {
		pattern.lastIndex = 0;
		for (;;) {
			const match = pattern.exec(text);
			if (!match) break;
			matches.push({ index: match.index, patternIndex });
		}
		pattern.lastIndex = 0;
	}
	return matches.sort((a, b) => a.index - b.index || a.patternIndex - b.patternIndex);
}

export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export async function writeText(path: string, text: string): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		await writeFile(temp, text, "utf8");
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

export async function writeNewText(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, { encoding: "utf8", flag: "wx" });
}

export async function appendText(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, text, "utf8");
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
	const text = await readText(path);
	if (!text) return fallback;
	return JSON.parse(text.replace(/^\uFEFF/, "")) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function yamlScalar(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (typeof value === "object") return JSON.stringify(value);
	const text = String(value);
	// Quote when parseScalar would reinterpret the bare text as a non-string
	// (numeric/boolean/null/JSON-looking), so serialize→parse round-trips.
	if (text === "" || /[#\n\r]|^\s|\s$/.test(text) || parseScalar(text) !== text) return JSON.stringify(text);
	return text;
}

export function frontmatter(data: Record<string, unknown>): string {
	const lines = ["---"];
	for (const [key, value] of Object.entries(data)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${yamlScalar(item)}`);
			}
		} else {
			lines.push(`${key}: ${yamlScalar(value)}`);
		}
	}
	lines.push("---", "");
	return lines.join("\n");
}

function parseScalar(value: string): unknown {
	const text = value.trim();
	if (text === "null") return null;
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
	if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		try {
			return JSON.parse(text);
		} catch {
			return text.slice(1, -1);
		}
	}
	return text;
}

export function parseFrontmatter(text: string | undefined): {
	data: Record<string, unknown>;
	body: string;
} {
	if (!text?.startsWith("---")) return { data: {}, body: text ?? "" };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { data: {}, body: text };
	const raw = text.slice(4, end).replace(/\r/g, "");
	const body = text.slice(end + 4).replace(/^\r?\n/, "");
	const data: Record<string, unknown> = {};
	const lines = raw.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const match = /^([^:]+):(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1].trim();
		const rest = match[2].trim();
		if (rest) {
			data[key] = parseScalar(rest);
			continue;
		}
		const values: unknown[] = [];
		while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
			index++;
			values.push(parseScalar(lines[index].replace(/^\s+-\s+/, "")));
		}
		data[key] = values;
	}
	return { data, body };
}
