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
