import { mkdir, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { StorePaths } from "./paths.ts";
import { frontmatter, parseFrontmatter, readText, writeText } from "./store.ts";

export const memoryPrivacyLevels = ["public", "shared", "private", "intimate"] as const;
export const memoryProvenanceValues = [
	"fei-direct",
	"her-direct",
	"her-observed",
	"her-inferred",
	"world-ingested",
] as const;
const CLASSIFICATION_MARKER = "her-privacy-classification";

export type MemoryPrivacy = (typeof memoryPrivacyLevels)[number];
export type MemoryProvenance = (typeof memoryProvenanceValues)[number];

export interface MemoryClassificationRecord {
	path: string;
	privacy: MemoryPrivacy;
	provenance: MemoryProvenance;
	reason: string;
	source: "frontmatter" | "inferred-ledger";
}

export interface MemoryClassificationResult {
	file: string;
	frontmatter: number;
	inferred: number;
	records: MemoryClassificationRecord[];
	total: number;
	updated: string;
}

export interface MemoryExportCheckResult {
	allowed: boolean;
	blocked: MemoryClassificationRecord[];
	checked: MemoryClassificationRecord[];
	unknown: string[];
}

const thirdPartyPatterns = [
	/\b(friend|partner|client|customer|coworker|colleague|family|someone told me)\b/i,
	/别人|朋友|客户|同事|家人|他说|她说|他们说|对方说/,
];

export function classifyCapturePrivacy(text: string, explicit?: MemoryPrivacy): MemoryPrivacy {
	if (explicit) return validateMemoryPrivacy(explicit);
	if (thirdPartyPatterns.some((pattern) => pattern.test(text))) return "intimate";
	return "private";
}

export function defaultWorldPrivacy(sourceUrl: string, explicit?: MemoryPrivacy): MemoryPrivacy {
	if (explicit) return validateMemoryPrivacy(explicit);
	if (/^https?:\/\//i.test(sourceUrl)) return "public";
	return "shared";
}

export function validateMemoryPrivacy(value: string): MemoryPrivacy {
	if (memoryPrivacyLevels.includes(value as MemoryPrivacy)) return value as MemoryPrivacy;
	throw new Error(`invalid memory privacy: ${value}`);
}

export function validateMemoryProvenance(value: string): MemoryProvenance {
	if (memoryProvenanceValues.includes(value as MemoryProvenance)) return value as MemoryProvenance;
	throw new Error(`invalid memory provenance: ${value}`);
}

export async function classifyMemoryCorpus(
	root: string,
	now = new Date().toISOString(),
): Promise<MemoryClassificationResult> {
	const paths = new StorePaths(root);
	await mkdir(paths.privacy, { recursive: true });
	const records: MemoryClassificationRecord[] = [];
	for (const file of await listMemoryMarkdown(root)) {
		const text = (await readText(resolve(root, file))) ?? "";
		records.push(classifyMemoryFile(file, text));
	}
	const result: MemoryClassificationResult = {
		file: relativeFromRoot(root, paths.privacyClassificationFile),
		total: records.length,
		frontmatter: records.filter((record) => record.source === "frontmatter").length,
		inferred: records.filter((record) => record.source === "inferred-ledger").length,
		records,
		updated: now,
	};
	await writeText(paths.privacyClassificationFile, renderClassification(result));
	return result;
}

export async function checkMemoryExport(root: string, refs: string[]): Promise<MemoryExportCheckResult> {
	const ledger = await readClassificationLedger(root);
	const checked: MemoryClassificationRecord[] = [];
	const blocked: MemoryClassificationRecord[] = [];
	const unknown: string[] = [];
	for (const ref of refs) {
		const safeRef = safeRelativeRef(root, ref);
		const direct = await classifyExistingRef(root, safeRef);
		const record = direct ?? ledger.get(safeRef);
		if (!record) {
			unknown.push(safeRef);
			continue;
		}
		checked.push(record);
		if (record.privacy === "private" || record.privacy === "intimate") blocked.push(record);
	}
	return { allowed: blocked.length === 0 && unknown.length === 0, checked, blocked, unknown };
}

async function listMemoryMarkdown(root: string): Promise<string[]> {
	const includeDirs = [
		"episodic/raw",
		"semantic",
		"world",
		"narrative",
		"choice-model",
		"goals",
		"tasks",
		"proposals/scan",
		"samantha",
	];
	const files: string[] = [];
	for (const dir of includeDirs) {
		files.push(...(await listMarkdownUnder(root, dir)));
	}
	return files.filter((file) => file !== "privacy/classification.md").sort();
}

async function listMarkdownUnder(root: string, dir: string): Promise<string[]> {
	const absolute = resolve(root, dir);
	const entries = await readdir(absolute, { withFileTypes: true }).catch((error: unknown) => {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	});
	const files: string[] = [];
	for (const entry of entries) {
		const entryPath = join(absolute, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listMarkdownUnder(root, relativeFromRoot(root, entryPath))));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".md")) files.push(relativeFromRoot(root, entryPath));
	}
	return files;
}

function classifyMemoryFile(path: string, text: string): MemoryClassificationRecord {
	const parsed = parseFrontmatter(text);
	const privacy = typeof parsed.data.privacy === "string" ? parsePrivacy(parsed.data.privacy) : undefined;
	const provenance = typeof parsed.data.provenance === "string" ? parseProvenance(parsed.data.provenance) : undefined;
	if (privacy && provenance) {
		return { path, privacy, provenance, source: "frontmatter", reason: "declared in memory frontmatter" };
	}
	const inferred = inferMemoryClassification(path, parsed.body || text, parsed.data);
	return { path, ...inferred, source: "inferred-ledger" };
}

function inferMemoryClassification(
	path: string,
	body: string,
	data: Record<string, unknown>,
): Pick<MemoryClassificationRecord, "privacy" | "provenance" | "reason"> {
	if (path.startsWith("episodic/raw/")) {
		return {
			privacy: classifyCapturePrivacy(body),
			provenance: "her-observed",
			reason: "legacy raw episode; classified in sidecar to preserve append-only raw",
		};
	}
	if (path.startsWith("world/")) {
		return {
			privacy: defaultWorldPrivacy(typeof data.source_url === "string" ? data.source_url : ""),
			provenance: "world-ingested",
			reason: "world note inferred from source URL",
		};
	}
	if (path.startsWith("choice-model/")) {
		return { privacy: "shared", provenance: "fei-direct", reason: "choice model encodes Fei feedback" };
	}
	if (path.startsWith("proposals/scan/")) {
		return { privacy: "shared", provenance: "her-observed", reason: "proactive scan proposal" };
	}
	if (path.startsWith("narrative/FACTS.md")) {
		return { privacy: "private", provenance: "fei-direct", reason: "FACTS.md is Fei-authored ground truth" };
	}
	if (path.startsWith("narrative/")) {
		return {
			privacy: "private",
			provenance: "her-inferred",
			reason: "narrative memory can contain personal context",
		};
	}
	if (path.startsWith("tasks/") || path.startsWith("goals/")) {
		return {
			privacy: "private",
			provenance: "her-observed",
			reason: "work state may contain private execution context",
		};
	}
	return { privacy: "private", provenance: "her-inferred", reason: "unknown memory surface defaults private" };
}

async function classifyExistingRef(root: string, ref: string): Promise<MemoryClassificationRecord | undefined> {
	const text = await readText(resolve(root, ref));
	if (!text) return undefined;
	const record = classifyMemoryFile(ref, text);
	return record.source === "frontmatter" ? record : undefined;
}

async function readClassificationLedger(root: string): Promise<Map<string, MemoryClassificationRecord>> {
	const paths = new StorePaths(root);
	const text = await readText(paths.privacyClassificationFile);
	if (!text) return new Map();
	const marker = new RegExp(`<!-- ${CLASSIFICATION_MARKER}\\n([\\s\\S]*?)\\n-->`, "m").exec(text);
	if (!marker) return new Map();
	const records = JSON.parse(marker[1] ?? "[]") as MemoryClassificationRecord[];
	return new Map(records.map((record) => [record.path, record]));
}

function renderClassification(result: MemoryClassificationResult): string {
	const lines = [
		frontmatter({
			type: "her_privacy_classification",
			updated: result.updated,
			total: result.total,
			frontmatter: result.frontmatter,
			inferred: result.inferred,
		}).trimEnd(),
		"",
		"# Her Privacy Classification Ledger",
		"",
		"Legacy append-only memories are classified here when their source files cannot be edited safely.",
		"",
		"| Path | Privacy | Provenance | Source | Reason |",
		"|---|---|---|---|---|",
		...result.records.map(
			(record) =>
				`| ${record.path} | ${record.privacy} | ${record.provenance} | ${record.source} | ${record.reason} |`,
		),
		"",
		`<!-- ${CLASSIFICATION_MARKER}`,
		JSON.stringify(result.records, null, 2),
		"-->",
		"",
	];
	return lines.join("\n");
}

function safeRelativeRef(root: string, ref: string): string {
	const resolved = resolve(root, ref);
	const relativePath = relativeFromRoot(root, resolved);
	if (relativePath.startsWith("..") || relativePath === "") throw new Error(`memory ref escapes root: ${ref}`);
	return relativePath;
}

function relativeFromRoot(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function parsePrivacy(value: string): MemoryPrivacy | undefined {
	try {
		return validateMemoryPrivacy(value);
	} catch {
		return undefined;
	}
}

function parseProvenance(value: string): MemoryProvenance | undefined {
	try {
		return validateMemoryProvenance(value);
	} catch {
		return undefined;
	}
}
