#!/usr/bin/env node
// palate T1 Day-1 gate: every `source_type: taste-card` world note must carry the fields the
// contract promises (docs/specs/palate-contracts/taste-card-contract.md §1). Deliberately does not
// import her-core's TS frontmatter parser — this script runs as plain node (no tsx), matching the
// other scripts/*.mjs check scripts, so it carries its own minimal read-only parser.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIRED_SCALAR_FIELDS = ["id", "title", "source_url", "captured_at"];

function parseFrontmatterKeys(text) {
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end < 0) return {};
	const raw = text.slice(4, end);
	const data = {};
	const lines = raw.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = /^([^:]+):(.*)$/.exec(lines[i]);
		if (!match) continue;
		const key = match[1].trim();
		const rest = match[2].trim();
		if (rest) {
			data[key] = rest;
			continue;
		}
		const values = [];
		while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
			i++;
			values.push(lines[i].replace(/^\s+-\s+/, "").trim());
		}
		data[key] = values;
	}
	return data;
}

function snapshotTextField(text) {
	const match = /^snapshot:\s*(\{.*\})\s*$/m.exec(text);
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]).text;
	} catch {
		return undefined;
	}
}

function missingFieldsForTasteCard(text, data) {
	const missing = [];
	for (const field of REQUIRED_SCALAR_FIELDS) {
		if (!(field in data) || String(data[field]).trim() === "") missing.push(field);
	}
	if (!("boards" in data)) missing.push("boards");
	const snapshotText = snapshotTextField(text);
	if (!snapshotText || !String(snapshotText).trim()) missing.push("snapshot.text");
	return missing;
}

function main() {
	const memoryDir = process.env.HER_MEMORY_DIR
		? resolve(process.env.HER_MEMORY_DIR)
		: resolve(process.cwd(), "..", "her-memory");
	const worldDir = join(memoryDir, "world");

	let entries;
	try {
		// world/ is intentionally not recursed: _snapshots/ and other subdirectories are not cards.
		entries = readdirSync(worldDir).filter((name) => name.endsWith(".md"));
	} catch (error) {
		console.error(`check-taste-schema: cannot read world dir ${worldDir}: ${error.message}`);
		process.exitCode = 1;
		return;
	}

	const failures = [];
	for (const entry of entries) {
		const text = readFileSync(join(worldDir, entry), "utf8");
		const data = parseFrontmatterKeys(text);
		if (data.source_type !== "taste-card") continue;
		const missing = missingFieldsForTasteCard(text, data);
		if (missing.length > 0) failures.push({ file: entry, missing });
	}

	if (failures.length > 0) {
		console.error("check-taste-schema: taste-card schema violations found:");
		for (const failure of failures) {
			console.error(`  ${failure.file}: missing ${failure.missing.join(", ")}`);
		}
		process.exitCode = 1;
		return;
	}

	console.log(`check-taste-schema: ${entries.length} world note(s) scanned, all taste-card entries valid.`);
}

main();
