export type MaterialKind = "youtube" | "tweet" | "web" | "local";

export type MaterialStatus = "ok" | "failed";

export interface ManifestItem {
	sourceUrl: string;
	localPath: string;
	kind: MaterialKind;
	words: number;
	fetchedAt: string;
	status: MaterialStatus;
	error?: string;
}

export interface Manifest {
	items: ManifestItem[];
}

export interface SourceClassification {
	kind: MaterialKind;
	id?: string;
	extension?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface YtDlpResult {
	stdout: string;
	stderr: string;
}

export type YtDlpRunner = (command: string, args: string[], cwd: string) => Promise<YtDlpResult>;

export interface AcquireOptions {
	memoryDir?: string;
	fetcher?: Fetcher;
	ytDlpRunner?: YtDlpRunner;
	now?: () => string;
	env?: NodeJS.ProcessEnv;
}

export interface MaterialPlan {
	absolutePath: string;
	relativePath: string;
	stem: string;
}

export interface HandlerContext {
	fetcher: Fetcher;
	ytDlpRunner: YtDlpRunner;
	env: NodeJS.ProcessEnv;
	materialsDir: string;
}

export interface AcquiredMaterial {
	words: number;
	status?: MaterialStatus;
	error?: string;
}

/** Catalog entry used by SYNTH. Fanout materials have `id`; acquire items do not. */
export interface CitationSource {
	id: string;
	sourceUrl: string;
}

export interface Citation {
	sourceId: string;
	sourceUrl: string;
	locator: string;
	href: string;
}

export type VerdictLevel = "verified" | "partial" | "unverifiable" | "misattributed" | "retracted";

export interface TimelineEntry {
	date: string;
	fact: string;
	citation: Citation;
}

export interface DisagreementClaim {
	sourceId: string;
	claim: string;
	citation: Citation;
}

export interface DisagreementEntry {
	topic: string;
	claims: DisagreementClaim[];
	verdict: VerdictLevel;
	note?: string;
}

export interface QuoteEntry {
	text: string;
	citation: Citation;
}

export interface DecisionOption {
	label: string;
	cost: string;
}

export interface DecisionPoint {
	question: string;
	options: DecisionOption[];
}

export interface DroppedCitation {
	sourceId: string;
	locator: string;
	reason: string;
}

export interface SynthesisDoc {
	title: string;
	slug: string;
	timeline: TimelineEntry[];
	disagreements: DisagreementEntry[];
	quotes: QuoteEntry[];
	decisions: DecisionPoint[];
	droppedCitations: DroppedCitation[];
}

/** Fanout chapter analysis consumed by SYNTH. `text` is the reader markdown. */
export interface ChapterAnalysis {
	materialId: string;
	sourceUrl?: string;
	chunkIndex?: number;
	text: string;
}

export interface SynthManifest {
	slug: string;
	title?: string;
	sources: readonly CitationSource[];
}
