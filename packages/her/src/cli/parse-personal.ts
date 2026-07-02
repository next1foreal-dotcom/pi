import type { JudgmentFields, WorldNoteData } from "../her-core/index.ts";
import type { CliCommand } from "./types.ts";
import { parseMemoryStatus, requireNonBlank, requireOptionValue, UsageError } from "./utils.ts";

export function parseJudgment(argv: string[]): CliCommand {
	let json = false;
	let noteId: string | undefined;
	const fields: JudgmentFields = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--note") {
			noteId = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--attraction") {
			fields.attraction = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--inferred-intent") {
			fields.inferredIntent = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--choice") {
			fields.choice = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--rejection") {
			fields.rejection = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--hesitation") {
			fields.hesitation = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--reason") {
			fields.reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--outcome") {
			fields.outcome = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--correction") {
			fields.correction = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown judgment option: ${arg}`);
	}
	if (!noteId?.trim()) throw new UsageError("judgment requires --note <id>");
	if (!Object.values(fields).some((value) => value?.trim())) {
		throw new UsageError("judgment requires at least one judgment field");
	}
	return { kind: "judgment", fields, json, noteId };
}

export function parseJournal(argv: string[]): CliCommand {
	let json = false;
	let journalKind: "daily" | "weekly" | undefined;
	let content: string | undefined;
	let runPath: string | undefined;
	let source: string | undefined;
	let timestamp: string | undefined;
	let title: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--kind") {
			const value = requireOptionValue(argv[++i], arg);
			if (value !== "daily" && value !== "weekly") throw new UsageError("--kind must be daily or weekly");
			journalKind = value;
			continue;
		}
		if (arg === "--text") {
			content = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--run" || arg === "--heartbeat-run") {
			runPath = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source") {
			source = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--timestamp") {
			timestamp = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--title") {
			title = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown journal option: ${arg}`);
	}
	if (!journalKind) throw new UsageError("journal requires --kind daily|weekly");
	return {
		kind: "journal",
		content: requireNonBlank(content, "--text"),
		journalKind,
		json,
		runPath,
		source,
		timestamp,
		title,
	};
}

export function parseTaste(argv: string[]): CliCommand {
	let differsFromFeiRule: string | undefined;
	let judgment: string | undefined;
	let json = false;
	let reason: string | undefined;
	let source: string | undefined;
	let timestamp: string | undefined;
	let title: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--title") {
			title = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--judgment") {
			judgment = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--reason") {
			reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--differs-from-fei-rule") {
			differsFromFeiRule = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--source") {
			source = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--timestamp") {
			timestamp = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown taste option: ${arg}`);
	}
	return {
		kind: "taste",
		title: requireNonBlank(title, "--title"),
		judgment: requireNonBlank(judgment, "--judgment"),
		reason: requireNonBlank(reason, "--reason"),
		json,
		...(differsFromFeiRule ? { differsFromFeiRule } : {}),
		...(source ? { source } : {}),
		...(timestamp ? { timestamp } : {}),
	};
}

export function parseMemoryStatusCommand(argv: string[]): CliCommand {
	let json = false;
	let noteId: string | undefined;
	let status: WorldNoteData["memoryStatus"] | undefined;
	let reason: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--note") {
			noteId = requireOptionValue(argv[++i], arg);
			continue;
		}
		if (arg === "--status") {
			status = parseMemoryStatus(requireOptionValue(argv[++i], arg));
			continue;
		}
		if (arg === "--reason") {
			reason = requireOptionValue(argv[++i], arg);
			continue;
		}
		throw new UsageError(`unknown memory-status option: ${arg}`);
	}
	if (!noteId?.trim()) throw new UsageError("memory-status requires --note <id>");
	if (!status) throw new UsageError("memory-status requires --status <active|archive_only|needs_deep_read>");
	return {
		kind: "memory-status",
		json,
		noteId,
		reason: requireNonBlank(reason, "--reason"),
		status,
	};
}

export function parsePrivacyCheck(argv: string[]): CliCommand {
	let json = false;
	const refs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--ref") {
			refs.push(requireOptionValue(argv[++i], arg));
			continue;
		}
		throw new UsageError(`unknown privacy-check option: ${arg}`);
	}
	if (refs.length === 0) throw new UsageError("privacy-check requires at least one --ref <memory-path>");
	return { kind: "privacy-check", json, refs };
}
