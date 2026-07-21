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

	get inboxTasks(): string {
		return join(this.tasks, "inbox");
	}

	get telegramConfirmations(): string {
		return join(this.tasks, "telegram-confirmations");
	}

	get activeTasks(): string {
		return join(this.tasks, "active");
	}

	get doneTasks(): string {
		return join(this.tasks, "done");
	}

	get outbox(): string {
		return join(this.root, "outbox");
	}

	get retractions(): string {
		return join(this.root, "retractions");
	}

	get evals(): string {
		return join(this.root, "evals");
	}

	get goldenEvals(): string {
		return join(this.evals, "golden");
	}

	get reports(): string {
		return join(this.root, "reports");
	}

	get tasteReports(): string {
		return join(this.root, "taste-reports");
	}

	get costReports(): string {
		return join(this.reports, "cost");
	}

	get privacy(): string {
		return join(this.root, "privacy");
	}

	get privacyClassificationFile(): string {
		return join(this.privacy, "classification.md");
	}

	get samantha(): string {
		return join(this.root, "samantha");
	}

	get samanthaJournal(): string {
		return join(this.samantha, "journal");
	}

	get samanthaJournalWeekly(): string {
		return join(this.samanthaJournal, "weekly");
	}

	get samanthaCollection(): string {
		return join(this.samantha, "collection");
	}

	get samanthaWants(): string {
		return join(this.samantha, "wants");
	}

	get samanthaTaste(): string {
		return join(this.samantha, "taste");
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
