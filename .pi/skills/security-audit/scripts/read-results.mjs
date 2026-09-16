/**
 * Reading worker results off disk, and refusing the ones that would be wrong.
 *
 * run-1's parent read each worker's reply out of the harness notification text:
 * HTML-escaped, retyped by the parent model into a file. pi-subagents does not
 * need any of that — it writes every child's raw bytes to
 * <runId>_<agent>_<i>_output.md next to the meta record, so the parent reads the
 * child's actual output instead of its own transcription of it.
 *
 * What does carry over is the refusal discipline, because every failure here is
 * silent:
 *   - two objects in one reply  → picking either one invents a decision
 *   - a duplicate key           → JSON.parse keeps the LAST value, no error
 *   - a truncated second object → the fragment looks like a well-formed record
 * None of these are visible to a schema validator downstream: each surviving
 * object is individually well-formed. So they are caught here, loudly, and the
 * unit goes back out to a fresh worker rather than into findings.json.
 *
 * Upstream protocol: Cloudflare security-audit skill (MIT) — see ../LICENSE.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { artifactsDir } from "./collect-usage.mjs";

/** Read one JSON string starting at the opening quote. Returns the raw body and the index after the closing quote. */
function readString(src, start) {
	let body = "";
	let escaped = false;
	let i = start + 1;
	for (; i < src.length; i++) {
		const ch = src[i];
		if (escaped) {
			body += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			body += ch;
			escaped = true;
			continue;
		}
		if (ch === '"') return { body, next: i + 1 };
		body += ch;
	}
	return { body, next: i, unterminated: true };
}

/**
 * Every top-level {...} in the text, string-aware so a brace inside a value
 * cannot end the object. A truncated tail is reported rather than dropped: a
 * child that ran out of output budget looks exactly like a child that had
 * nothing more to say.
 */
export function scanTopLevelObjects(text) {
	const found = [];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			i = readString(text, i).next - 1;
			continue;
		}
		if (text[i] !== "{") continue;

		let depth = 0;
		let j = i;
		for (; j < text.length; j++) {
			const ch = text[j];
			if (ch === '"') {
				j = readString(text, j).next - 1;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) break;
		}
		if (depth !== 0) {
			found.push({ start: i, truncated: true });
			break;
		}
		const src = text.slice(i, j + 1);
		try {
			found.push({ start: i, end: j + 1, src, value: JSON.parse(src) });
		} catch (error) {
			found.push({ start: i, end: j + 1, src, error: String(error.message).slice(0, 120) });
		}
		i = j;
	}
	return found;
}

function decodeKey(body) {
	try {
		return JSON.parse(`"${body}"`);
	} catch {
		return body;
	}
}

/**
 * Keys repeated within one object, as dotted paths.
 *
 * Counting per nesting *depth* instead of per object instance is the trap: every
 * trace[] in a real finding is a list of sibling objects sharing the same keys,
 * and a depth-keyed counter calls all of them duplicates. Each `{` therefore
 * gets its own frame.
 */
export function findDuplicateKeys(src) {
	const duplicates = [];
	const stack = [];
	let pendingKey = null;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === '"') {
			const { body, next } = readString(src, i);
			let k = next;
			while (k < src.length && (src[k] === " " || src[k] === "\t" || src[k] === "\n" || src[k] === "\r")) k++;
			const frame = stack[stack.length - 1];
			if (src[k] === ":" && frame?.isObject) {
				const key = decodeKey(body);
				const path = [...stack.map((f) => f.label).filter(Boolean), key].join(".");
				if (frame.keys.has(key)) duplicates.push(path);
				else frame.keys.add(key);
				pendingKey = key;
			}
			i = next - 1;
			continue;
		}
		if (ch === "{") {
			stack.push({ isObject: true, keys: new Set(), label: pendingKey });
			pendingKey = null;
		} else if (ch === "[") {
			stack.push({ isObject: false, label: pendingKey });
			pendingKey = null;
		} else if (ch === "}" || ch === "]") {
			stack.pop();
		}
	}
	return [...new Set(duplicates)];
}

/**
 * The one object a worker was asked for, or a stated reason it cannot be used.
 * `requiredKeys` is what makes an object a candidate — it separates the answer
 * from any JSON a worker happened to quote while explaining itself.
 */
export function extractSingleJsonObject(text, { requiredKeys = [] } = {}) {
	const objects = scanTopLevelObjects(text);

	const truncated = objects.filter((o) => o.truncated);
	if (truncated.length > 0) {
		return { ok: false, reason: `reply ends inside an unterminated JSON object at offset ${truncated[0].start}` };
	}

	const unparsable = objects.filter((o) => o.error);
	if (unparsable.length > 0) {
		return {
			ok: false,
			reason: `${unparsable.length} unparsable top-level JSON object(s): ${unparsable.map((o) => o.error).join(" | ")}`,
		};
	}

	const candidates = objects.filter((o) => requiredKeys.every((key) => key in o.value));
	if (candidates.length === 0) {
		return {
			ok: false,
			reason: `no top-level JSON object carrying ${requiredKeys.join(", ")} (scanned ${objects.length} object(s))`,
		};
	}
	if (candidates.length > 1) {
		return { ok: false, reason: `${candidates.length} candidate objects — a reply must contain exactly one` };
	}

	const [only] = candidates;
	const duplicates = findDuplicateKeys(only.src);
	if (duplicates.length > 0) {
		return { ok: false, reason: `duplicate key(s) inside the object: ${duplicates.join(", ")}` };
	}

	return {
		ok: true,
		value: only.value,
		source: only.src,
		preamble: text.slice(0, only.start).trim().length > 0,
		postamble: text.slice(only.end).trim().length > 0,
	};
}

const ARTIFACT_KINDS = { "_meta.json": "meta", "_output.md": "output", "_input.md": "input" };

/**
 * Split `<runId>_<agent>_<i>_<kind>`. Agent ids may contain underscores (the
 * ledger's own id rule allows them), so the split works inward from both ends
 * rather than on the second underscore.
 */
export function parseArtifactName(name) {
	const suffix = Object.keys(ARTIFACT_KINDS).find((s) => name.endsWith(s));
	if (!suffix) return null;
	const stem = name.slice(0, -suffix.length);
	const firstUnderscore = stem.indexOf("_");
	const lastUnderscore = stem.lastIndexOf("_");
	if (firstUnderscore < 1 || lastUnderscore <= firstUnderscore) return null;
	const index = stem.slice(lastUnderscore + 1);
	if (!/^\d+$/.test(index)) return null;
	return {
		runId: stem.slice(0, firstUnderscore),
		agent: stem.slice(firstUnderscore + 1, lastUnderscore),
		index: Number(index),
		kind: ARTIFACT_KINDS[suffix],
	};
}

/**
 * Every child of a fan-out, output paired with meta. `runId` scopes the read to
 * one fan-out: the directory accumulates across runs, and a wave that absorbs an
 * earlier wave's children reports coverage it never had.
 */
export function readChildOutputs(projectPath, { runId = null, since = 0, home = homedir() } = {}) {
	const dir = artifactsDir(projectPath, home);
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (error) {
		return { dir, available: false, reason: String(error.message ?? error), children: [] };
	}

	const groups = new Map();
	for (const name of entries) {
		const parsed = parseArtifactName(name);
		if (!parsed) continue;
		if (runId && parsed.runId !== runId) continue;
		const key = `${parsed.runId}_${parsed.agent}_${parsed.index}`;
		const group = groups.get(key) ?? { key, ...parsed, files: {} };
		delete group.kind;
		group.files[parsed.kind] = join(dir, name);
		groups.set(key, group);
	}

	const children = [];
	for (const group of groups.values()) {
		if (!group.files.meta) continue;
		let meta;
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(group.files.meta).mtimeMs;
			meta = JSON.parse(readFileSync(group.files.meta, "utf8"));
		} catch (error) {
			children.push({ ...group, unreadableMeta: String(error.message ?? error), output: null });
			continue;
		}
		if (mtimeMs < since) continue;

		let output = null;
		let outputMissing;
		if (group.files.output) {
			try {
				output = readFileSync(group.files.output, "utf8");
			} catch (error) {
				outputMissing = String(error.message ?? error);
			}
		} else {
			// A child that died before writing anything. Worth surfacing as a
			// child with no output, not worth dropping: a wave that silently
			// shrinks is how a coverage ledger ends up claiming units nobody ran.
			outputMissing = "no output file";
		}

		children.push({
			key: group.key,
			runId: group.runId,
			agent: group.agent,
			index: group.index,
			task: meta.task ?? null,
			exitCode: typeof meta.exitCode === "number" ? meta.exitCode : -1,
			model: meta.model ?? null,
			attemptedModels: meta.attemptedModels ?? null,
			usage: meta.usage ?? null,
			durationMs: meta.durationMs ?? null,
			toolCount: meta.toolCount ?? null,
			timestamp: meta.timestamp ?? null,
			outputPath: group.files.output ?? null,
			output,
			...(outputMissing ? { outputMissing } : {}),
		});
	}

	children.sort((a, b) => (a.runId === b.runId ? a.index - b.index : a.runId < b.runId ? -1 : 1));
	return { dir, available: true, children };
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
	const [, , projectPath, runId] = process.argv;
	if (!projectPath) {
		console.error("usage: node read-results.mjs <project-cwd> [runId]");
		process.exit(2);
	}
	const result = readChildOutputs(projectPath, { runId: runId ?? null });
	if (!result.available) {
		console.log(`no artifacts dir: ${result.dir}`);
		console.log(`reason: ${result.reason}`);
		process.exit(1);
	}
	console.log(`dir: ${result.dir}`);
	for (const child of result.children) {
		const bytes = child.output === null ? `MISSING (${child.outputMissing})` : `${child.output.length}b`;
		console.log(`${child.key}  exit=${child.exitCode}  ${child.durationMs}ms  tools=${child.toolCount}  ${bytes}`);
	}
	console.log(`${result.children.length} child record(s)`);
}
