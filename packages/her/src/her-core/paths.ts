import { join } from "node:path";

export class StorePaths {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	get episodic(): string {
		return join(this.root, "episodic");
	}

	get raw(): string {
		return join(this.episodic, "raw");
	}

	get semantic(): string {
		return join(this.root, "semantic");
	}

	get archive(): string {
		return join(this.root, "archive");
	}

	get archiveSemantic(): string {
		return join(this.archive, "semantic");
	}

	get narrative(): string {
		return join(this.root, "narrative");
	}

	get contextFile(): string {
		return join(this.narrative, "CONTEXT.md");
	}

	get soulFile(): string {
		return join(this.narrative, "SOUL.md");
	}

	get selfFile(): string {
		return join(this.narrative, "SAMANTHA.md");
	}

	get choiceModelFile(): string {
		return join(this.narrative, "CHOICE-MODEL.md");
	}

	get choiceModelDir(): string {
		return join(this.root, "choice-model");
	}

	get becoming(): string {
		return join(this.narrative, "becoming-moments.md");
	}

	get factsFile(): string {
		return join(this.narrative, "FACTS.md");
	}

	get recognitions(): string {
		return join(this.root, "recognitions");
	}

	get proposals(): string {
		return join(this.root, "proposals");
	}

	get scanProposals(): string {
		return join(this.proposals, "scan");
	}

	get world(): string {
		return join(this.root, "world");
	}

	get topics(): string {
		return join(this.root, "topics");
	}

	get ideas(): string {
		return join(this.root, "ideas");
	}

	get goals(): string {
		return join(this.root, "goals");
	}

	get tasks(): string {
		return join(this.root, "tasks");
	}

	get activeTasks(): string {
		return join(this.tasks, "active");
	}

	get doneTasks(): string {
		return join(this.tasks, "done");
	}

	get samantha(): string {
		return join(this.root, "samantha");
	}

	get samanthaJournal(): string {
		return join(this.samantha, "journal");
	}

	get samanthaCollection(): string {
		return join(this.samantha, "collection");
	}

	get samanthaProjects(): string {
		return join(this.samantha, "projects");
	}

	get samanthaTools(): string {
		return join(this.samantha, "tools");
	}

	get samanthaDreams(): string {
		return join(this.samantha, "dreams");
	}

	get herDir(): string {
		return join(this.root, ".her");
	}

	get configFile(): string {
		return join(this.herDir, "config.yaml");
	}

	get stateFile(): string {
		return join(this.herDir, "state.json");
	}

	get seenFile(): string {
		return join(this.herDir, "seen.json");
	}

	dailyEpisode(date: string): string {
		return join(this.episodic, `${date}.md`);
	}
}
