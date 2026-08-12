import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireSources } from "./acquire.ts";

interface ParsedArgs {
	slug?: string;
	input?: string;
	sources: string[];
	help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
	const parsed: ParsedArgs = { sources: [], help: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--slug") {
			parsed.slug = argv[++index];
			continue;
		}
		if (arg === "--input" || arg === "--input-file" || arg === "--json") {
			parsed.input = argv[++index];
			continue;
		}
		if (arg === "--") {
			parsed.sources.push(...argv.slice(index + 1));
			break;
		}
		if (arg?.startsWith("-")) throw new Error(`unknown option: ${arg}`);
		if (arg) parsed.sources.push(arg);
	}
	return parsed;
}

function sourceArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
	}
	if (typeof value === "object" && value !== null && ("sources" in value || "urls" in value)) {
		const sourceValue = value as { sources?: unknown; urls?: unknown };
		const sources = sourceValue.sources ?? sourceValue.urls;
		if (Array.isArray(sources)) {
			return sources.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		}
	}
	throw new Error("input JSON must be an array of strings or an object with a sources array");
}
async function readInputFile(path: string): Promise<string[]> {
	return sourceArray(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
}

function usage(): string {
	return [
		"Usage: node --import tsx packages/her/src/compendium/cli-acquire.ts --slug <slug> [--input <file.json>] [sources...]",
		"Input JSON may be a string array or an object with a sources array.",
	].join("\n");
}

export async function runAcquireCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const parsed = parseArgs(argv);
	if (parsed.help) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}
	if (!parsed.slug) throw new Error("--slug is required");
	const fileSources = parsed.input ? await readInputFile(parsed.input) : [];
	const sources = [...fileSources, ...parsed.sources];
	if (!sources.length) throw new Error("at least one source is required");
	const manifest = await acquireSources(sources, parsed.slug, { env });
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
	return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
	runAcquireCli(process.argv.slice(2)).catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
