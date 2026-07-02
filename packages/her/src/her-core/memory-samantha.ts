import { join } from "node:path";
import type {
	SamanthaJournalInput,
	SamanthaJournalResult,
	SamanthaTasteJudgmentInput,
	SamanthaTasteJudgmentResult,
	SamanthaZoneCategory,
	SamanthaZoneNoteInput,
	SamanthaZoneNoteResult,
} from "./memory-types.ts";
import { genId, slug, today } from "./memory-utils.ts";
import type { StorePaths } from "./paths.ts";
import { frontmatter, redactSecrets, writeNewText, writeText } from "./store.ts";

export async function writeSamanthaZoneNote(
	paths: StorePaths,
	data: SamanthaZoneNoteInput,
): Promise<SamanthaZoneNoteResult> {
	const title = data.title.trim();
	const content = data.content.trim();
	if (!title) throw new Error("writeSamanthaZoneNote requires a title");
	if (!content) throw new Error("writeSamanthaZoneNote requires content");
	const id = genId(`${data.category}:${title}`, content);
	const key = slug(title);
	const dir = samanthaZoneDir(paths, data.category);
	const relativePath = `samantha/${data.category}/${today()}--${key}--${id}.md`;
	await writeText(
		join(dir, `${today()}--${key}--${id}.md`),
		`${frontmatter({
			id,
			title,
			category: data.category,
			created: today(),
			source: data.source ?? "her_zone_note",
		})}# ${title}\n\n${content}\n`,
	);
	return { id, path: relativePath };
}

export async function writeSamanthaJournal(
	paths: StorePaths,
	data: SamanthaJournalInput,
): Promise<SamanthaJournalResult> {
	const content = redactSecrets(data.content.trim());
	if (!content) throw new Error("writeSamanthaJournal requires content");
	const createdAt = data.timestamp ? new Date(data.timestamp) : new Date();
	if (Number.isNaN(createdAt.getTime())) throw new Error(`invalid journal timestamp: ${data.timestamp}`);
	const created = createdAt.toISOString();
	const date = created.slice(0, 10);
	const title = (data.title?.trim() || `${data.kind === "weekly" ? "Weekly Review" : "Daily Journal"} ${date}`).trim();
	const id = genId(`${data.kind}:${created}:${title}`, content);
	const key = slug(title);
	const dir = data.kind === "weekly" ? paths.samanthaJournalWeekly : paths.samanthaJournal;
	const relDir = data.kind === "weekly" ? "samantha/journal/weekly" : "samantha/journal";
	const relativePath = `${relDir}/${date}--${key}--${id}.md`;
	await writeNewText(
		join(dir, `${date}--${key}--${id}.md`),
		`${frontmatter({
			id,
			title,
			kind: data.kind,
			created,
			source: data.source ?? "her-heartbeat",
			privacy: "private",
			provenance: "her-direct",
			protected_zone: true,
			consolidate: false,
			evaluate: false,
			roi: false,
			auto_promote: false,
			...(data.runPath ? { heartbeat_run: data.runPath } : {}),
		})}# ${title}\n\n${content}\n`,
	);
	return { id, kind: data.kind, path: relativePath };
}

export async function writeSamanthaTasteJudgment(
	paths: StorePaths,
	data: SamanthaTasteJudgmentInput,
): Promise<SamanthaTasteJudgmentResult> {
	const title = data.title.trim();
	const judgment = redactSecrets(data.judgment.trim());
	const reason = redactSecrets(data.reason.trim());
	const differsFromFeiRule = data.differsFromFeiRule ? redactSecrets(data.differsFromFeiRule.trim()) : undefined;
	if (!title) throw new Error("writeSamanthaTasteJudgment requires a title");
	if (!judgment) throw new Error("writeSamanthaTasteJudgment requires judgment");
	if (!reason) throw new Error("writeSamanthaTasteJudgment requires reason");
	const createdAt = data.timestamp ? new Date(data.timestamp) : new Date();
	if (Number.isNaN(createdAt.getTime())) {
		throw new Error(`invalid taste judgment timestamp: ${data.timestamp}`);
	}
	const created = createdAt.toISOString();
	const date = created.slice(0, 10);
	const id = genId(`taste:${created}:${title}`, `${judgment}\n${reason}\n${differsFromFeiRule ?? ""}`);
	const key = slug(title);
	const relativePath = `samantha/taste/${date}--${key}--${id}.md`;
	const body = [
		`# ${title}`,
		"",
		"## Judgment",
		"",
		judgment,
		"",
		"## Reason",
		"",
		reason,
		...(differsFromFeiRule ? ["", "## Difference From Fei Rule", "", differsFromFeiRule] : []),
		"",
	].join("\n");
	await writeNewText(
		join(paths.samanthaTaste, `${date}--${key}--${id}.md`),
		`${frontmatter({
			id,
			title,
			category: "taste",
			created,
			source: data.source ?? "her-taste",
			privacy: "private",
			provenance: "her-direct",
			protected_zone: true,
			consolidate: false,
			evaluate: false,
			roi: false,
			auto_promote: false,
			...(differsFromFeiRule ? { differs_from_fei_rule: true } : {}),
		})}${body}`,
	);
	return { id, path: relativePath };
}

function samanthaZoneDir(paths: StorePaths, category: SamanthaZoneCategory): string {
	if (category === "journal") return paths.samanthaJournal;
	if (category === "collection") return paths.samanthaCollection;
	if (category === "wants") return paths.samanthaWants;
	if (category === "taste") return paths.samanthaTaste;
	if (category === "projects") return paths.samanthaProjects;
	if (category === "tools") return paths.samanthaTools;
	return paths.samanthaDreams;
}
