import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { renderConfig } from "./config.ts";
import {
	CHOICE_MODEL_RULE_FILES,
	SAMANTHA_ZONE_READMES,
	SEED_CHOICE_MODEL,
	SEED_CONTEXT,
	SEED_SELF_NARRATIVE,
	SEED_SOUL,
} from "./memory-seeds.ts";
import { StorePaths } from "./paths.ts";
import { writeJson, writeText } from "./store.ts";

export async function initStore(root: string): Promise<StorePaths> {
	const paths = new StorePaths(root);
	for (const dir of [
		paths.raw,
		paths.semantic,
		paths.archiveSemantic,
		paths.narrative,
		paths.recognitions,
		paths.proposals,
		paths.scanProposals,
		paths.world,
		paths.topics,
		paths.ideas,
		paths.goals,
		paths.tasks,
		paths.inboxTasks,
		paths.activeTasks,
		paths.doneTasks,
		paths.outbox,
		paths.retractions,
		paths.goldenEvals,
		paths.reports,
		paths.costReports,
		paths.privacy,
		paths.choiceModelDir,
		paths.samantha,
		paths.samanthaJournal,
		paths.samanthaCollection,
		paths.samanthaProjects,
		paths.samanthaTools,
		paths.samanthaDreams,
		paths.herDir,
	]) {
		await mkdir(dir, { recursive: true });
	}
	await writeText(paths.configFile, renderConfig());
	await writeJson(paths.stateFile, { cursor: null, last_consolidate: null, last_synthesize: null });
	await writeText(paths.contextFile, SEED_CONTEXT);
	await writeText(paths.soulFile, SEED_SOUL);
	await writeText(paths.selfFile, SEED_SELF_NARRATIVE);
	await writeText(paths.choiceModelFile, SEED_CHOICE_MODEL);
	for (const [file, content] of CHOICE_MODEL_RULE_FILES) {
		await writeText(join(paths.choiceModelDir, file), content);
	}
	for (const [dirKey, content] of SAMANTHA_ZONE_READMES) {
		await writeText(join(paths[dirKey], "README.md"), content);
	}
	await writeText(join(paths.root, ".gitignore"), "# secrets - never commit\n.env\n.her/lock\n");
	await writeText(join(paths.root, ".env.example"), "HER_LLM_API_KEY=your-key-here\n");
	return paths;
}
