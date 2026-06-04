import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type HerConfig, loadConfig, renderConfig } from "./config.ts";
import type { ModelLike } from "./model.ts";
import { StorePaths } from "./paths.ts";
import { consolidatePrompt, ideaEnginePrompt, summaryPrompt, synthesizePrompt, topicMapPrompt } from "./prompts.ts";
import { type CorpusDoc, lexicalSearch, type Note } from "./retrieval.ts";
import {
	appendText,
	frontmatter,
	parseFrontmatter,
	readJson,
	readText,
	redactSecrets,
	writeJson,
	writeText,
} from "./store.ts";

const execFileAsync = promisify(execFile);
const UNIT_TYPES = new Set(["question", "concept", "opinion", "case", "solution"]);
const RELATION_TYPES = new Set(["responds", "explains", "proves", "conflicts", "relates"]);

export const SEED_CONTEXT =
	"# CONTEXT - Living Narrative / alive narrative\n\n*(empty - Samantha has not yet formed an understanding of Fei.)*\n";

export interface CaptureMeta {
	timestamp?: string;
	sessionId?: string;
	session_id?: string;
	project?: string;
	type?: string;
	ref?: string;
}

export interface WorldNoteData {
	title: string;
	sourceUrl: string;
	sourceType: string;
	contentHash: string;
	memoryStatus: "active" | "archive_only" | "needs_deep_read";
	extracted: string;
	coverage: string;
	read: string;
	steal: string[];
	connections: string[];
	take: string;
	possibleMoves: string[];
}

export interface IdeaData {
	title: string;
	content: string;
	connections?: string[];
	source?: string;
}

export interface SurfaceOptions {
	query?: string;
	sessionId?: string;
	cooldownMinutes?: number;
}

export interface JudgmentFields {
	attraction?: string;
	inferredIntent?: string;
	choice?: string;
	rejection?: string;
	hesitation?: string;
	reason?: string;
	outcome?: string;
	correction?: string;
}

export interface MemorySyncResult {
	status: "clean" | "pushed";
	commit?: string;
}

export interface ConsolidateResult {
	episodes: number;
	notesTouched: number;
	moments: number;
}

export class Memory {
	readonly paths: StorePaths;
	private readonly model?: ModelLike;
	private readonly config: HerConfig;

	constructor(root: string, model?: ModelLike, config?: HerConfig) {
		this.paths = new StorePaths(root);
		this.model = model;
		this.config = config ?? loadConfig(this.paths.configFile);
	}

	async capture(raw: string, meta: CaptureMeta = {}): Promise<string> {
		const ts = meta.timestamp ?? timestampMinute();
		const sid = meta.sessionId ?? meta.session_id ?? genId(ts, raw);
		const date = safeStem(ts.slice(0, 10));
		const project = meta.project ?? "unknown";
		const rawStem = `${safeStem(ts)}--${safeStem(sid)}`;
		const rawFm = { id: sid, timestamp: ts, project, session_id: sid };
		const safeRaw = redactSecrets(raw);

		await writeText(join(this.paths.raw, `${rawStem}.md`), `${frontmatter(rawFm)}\n${safeRaw}`);

		let pending = false;
		let summary: string;
		try {
			if (!this.model) throw new Error("no model configured");
			summary = await this.model.complete(summaryPrompt(safeRaw));
		} catch {
			summary = "- (summary pending - summarizer unavailable)";
			pending = true;
		}

		await appendText(this.paths.dailyEpisode(date), episodeSection(sid, ts, project, summary, rawStem, pending));
		if (meta.type === "recognition_response" && meta.ref) {
			await this.markRecognitionAnswered(meta.ref, sid);
		}
		return sid;
	}

	async getContext(): Promise<{ context: string; facts: string }> {
		const context = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
		const facts = (await readText(this.paths.factsFile)) ?? "";
		return { context: `${await this.staleBanner()}${context}`, facts };
	}

	async recall(query: string, opts: { k?: number } = {}): Promise<Note[]> {
		return lexicalSearch(query, await this.corpus(), opts.k ?? 5);
	}

	async surface(opts: SurfaceOptions = {}): Promise<Note | undefined> {
		const state = await readJson<{
			mirror?: {
				lastAtBySession?: Record<string, string>;
				surfacedBySession?: Record<string, string[]>;
			};
		}>(this.paths.stateFile, {});
		const sessionId = opts.sessionId ?? "global";
		const cooldownMs = (opts.cooldownMinutes ?? 30) * 60000;
		const lastAt = state.mirror?.lastAtBySession?.[sessionId];
		if (lastAt && cooldownMs > 0 && Date.now() - Date.parse(lastAt) < cooldownMs) return undefined;

		const surfaced = new Set(state.mirror?.surfacedBySession?.[sessionId] ?? []);
		const corpus = await this.corpus();
		const query = opts.query?.trim();
		const ranked = query ? lexicalSearch(query, corpus, 20) : [];
		const candidates = ranked.length > 0 ? ranked : corpus.map((doc) => ({ ...doc, score: 0 }));
		const hit = candidates.find((note) => !surfaced.has(note.id));
		if (!hit) return undefined;

		surfaced.add(hit.id);
		await writeJson(this.paths.stateFile, {
			...state,
			mirror: {
				...state.mirror,
				lastAtBySession: {
					...(state.mirror?.lastAtBySession ?? {}),
					[sessionId]: new Date().toISOString(),
				},
				surfacedBySession: {
					...(state.mirror?.surfacedBySession ?? {}),
					[sessionId]: [...surfaced].slice(-200),
				},
			},
		});
		return hit;
	}

	async remember(content: string, type = "note"): Promise<string> {
		const id = genId(new Date().toISOString(), content);
		const key = slug(content.split(/\r?\n/, 1)[0] ?? "note");
		await writeText(
			join(this.paths.semantic, `${key}-${id}.md`),
			`${frontmatter({ id, type, created: today() })}# ${key}\n\n${content.trim()}\n`,
		);
		return id;
	}

	async consolidate(limit = 25): Promise<ConsolidateResult> {
		if (!this.model) throw new Error("consolidate requires a model");
		const state = await readJson<{ cursor?: string | null; last_consolidate?: string | null }>(
			this.paths.stateFile,
			{},
		);
		const episodes = (await this.episodesSince(state.cursor ?? null)).slice(0, limit);
		if (episodes.length === 0) return { episodes: 0, notesTouched: 0, moments: 0 };

		const joined = episodes.map((episode) => `[${episode.id}] ${episode.text}`).join("\n\n");
		const existing = await markdownStems(this.paths.semantic);
		const result = extractJson<{
			notes?: Array<Record<string, unknown>>;
			moments?: Array<{ trigger?: string; shift?: string }>;
		}>(await this.model.complete(consolidatePrompt(joined, existing)));
		const notes = result.notes ?? [];
		const moments = result.moments ?? [];
		const newCursor = episodes.at(-1)?.ts ?? "";

		for (const note of notes) await this.upsertNote(note);
		if (moments.length > 0) {
			const date = newCursor.slice(0, 10);
			await appendText(
				this.paths.becoming,
				moments
					.map((moment) => `- ${date} · trigger: ${moment.trigger ?? ""} · shift: ${moment.shift ?? ""}\n`)
					.join(""),
			);
		}

		await writeJson(this.paths.stateFile, {
			...state,
			cursor: newCursor,
			last_consolidate: newCursor,
		});
		return { episodes: episodes.length, notesTouched: notes.length, moments: moments.length };
	}

	async synthesize(): Promise<string> {
		if (!this.model) throw new Error("synthesize requires a model");
		const current = (await readText(this.paths.contextFile)) ?? SEED_CONTEXT;
		const notes = await readMarkdownDir(this.paths.semantic);
		const moments = (await readText(this.paths.becoming)) ?? "";
		const facts = (await readText(this.paths.factsFile)) ?? "";
		const draft = await this.model.complete(synthesizePrompt(current, notes, moments, facts), { strong: true });
		const proposalId = `${today()}-narrative-update`;
		await writeText(join(this.paths.proposals, `${proposalId}.md`), draft);
		const state = await readJson<Record<string, unknown>>(this.paths.stateFile, {});
		await writeJson(this.paths.stateFile, { ...state, last_synthesize: today() });
		return proposalId;
	}

	async approve(proposalId: string): Promise<void> {
		const proposed = await readText(join(this.paths.proposals, `${proposalId}.md`));
		if (proposed === undefined) throw new Error(`no proposal: ${proposalId}`);
		await writeText(this.paths.contextFile, proposed);
	}

	async buildTopicMaps(): Promise<string[]> {
		if (!this.model) throw new Error("buildTopicMaps requires a model");
		const units = await this.noteSummaries();
		if (units.length === 0) return [];
		const lines = units.map((unit) => `- ${unit.key} (${unit.type}): ${unit.title}`).join("\n");
		const result = extractJson<{ maps?: Array<{ theme?: string; summary?: string; members?: string[] }> }>(
			await this.model.complete(topicMapPrompt(lines), { strong: true }),
		);
		const keyset = new Set(units.map((unit) => unit.key));
		const written: string[] = [];
		for (const map of result.maps ?? []) {
			if (!map.theme) continue;
			const key = slug(map.theme);
			const members = (map.members ?? []).map(slug).filter((member) => keyset.has(member));
			await writeText(
				join(this.paths.topics, `${key}.md`),
				`${frontmatter({ theme: map.theme, created: today(), members })}# ${map.theme}\n\n${map.summary ?? ""}\n\n## Units\n${members.map((member) => `- [[${member}]]`).join("\n")}\n`,
			);
			written.push(key);
		}
		return written;
	}

	async generateIdeas(): Promise<Array<{ id: string; title: string; kind: string }>> {
		if (!this.model) throw new Error("generateIdeas requires a model");
		const units = await this.noteSummaries();
		if (units.length === 0) return [];
		const unitLines = units.map((unit) => `- ${unit.key} (${unit.kind}/${unit.type}): ${unit.title}`).join("\n");
		const topicLines = (await this.topicSummaries()).join("\n") || "(none)";
		const existing = (await this.existingIdeaTitles()).join("\n") || "(none)";
		const result = extractJson<{
			ideas?: Array<{
				title?: string;
				connects?: string[];
				insight?: string;
				spark?: string;
				kind?: string;
			}>;
		}>(await this.model.complete(ideaEnginePrompt(unitLines, topicLines, existing), { strong: true }));
		const written: Array<{ id: string; title: string; kind: string }> = [];
		for (const idea of result.ideas ?? []) {
			if (!idea.title) continue;
			const id = genId(today(), idea.title);
			const connects = (idea.connects ?? []).map(slug).filter(Boolean);
			const kind = idea.kind ?? "";
			const body = `# ${idea.title}\n\n**Insight:** ${idea.insight ?? ""}\n\n**Spark:** ${idea.spark ?? ""}\n\n## Connects\n${connects.map((item) => `- [[${item}]]`).join("\n")}\n`;
			await writeText(
				join(this.paths.ideas, `${today()}--${id}.md`),
				`${frontmatter({ id, created: today(), kind, status: "new", connects })}${body}`,
			);
			written.push({ id, title: idea.title, kind });
		}
		return written;
	}

	async writeIdea(data: IdeaData): Promise<string> {
		const id = genId(data.title, data.content);
		const key = slug(data.title);
		const connections = data.connections ?? [];
		const body = `# ${data.title}

${data.content.trim()}

## Connections

${connections.map((item) => `- [[${item}]]`).join("\n")}
`;
		await writeText(
			join(this.paths.ideas, `${today()}--${key}--${id}.md`),
			`${frontmatter({ id, title: data.title, created: today(), source: data.source ?? "her_idea", connections })}${body}`,
		);
		return id;
	}

	async writeWorldNote(data: WorldNoteData): Promise<string> {
		const seen = await readJson<Record<string, string>>(this.paths.seenFile, {});
		const existing = seen[data.contentHash];
		if (existing) return existing;

		let noteSlug = slug(data.title);
		let path = join(this.paths.world, `${noteSlug}.md`);
		const existingText = await readText(path);
		if (existingText) {
			const parsed = parseFrontmatter(existingText);
			if (parsed.data.content_hash !== data.contentHash) {
				noteSlug = `${noteSlug}-${data.contentHash.slice(0, 6)}`;
				path = join(this.paths.world, `${noteSlug}.md`);
			}
		}

		const id = genId(data.contentHash, noteSlug);
		const fm = {
			id,
			title: data.title,
			source_url: data.sourceUrl,
			source_type: data.sourceType,
			captured_at: new Date().toISOString(),
			content_hash: data.contentHash,
			status: "captured",
			memory_status: data.memoryStatus,
			response_version: 1,
		};
		await writeText(path, `${frontmatter(fm)}${worldBody(data)}`);
		seen[data.contentHash] = id;
		await writeJson(this.paths.seenFile, seen);
		return id;
	}

	async recordJudgment(noteId: string, fields: JudgmentFields): Promise<void> {
		const path = await this.findWorldNote(noteId);
		const text = await readText(path);
		const parsed = parseFrontmatter(text);
		const body = appendJudgment(parsed.body, fields);
		await writeText(path, `${frontmatter(parsed.data)}${body}`);
	}

	async setMemoryStatus(
		noteId: string,
		status: "active" | "archive_only" | "needs_deep_read",
		reason: string,
	): Promise<void> {
		const path = await this.findWorldNote(noteId);
		const text = await readText(path);
		const parsed = parseFrontmatter(text);
		parsed.data.memory_status = status;
		const body = `${stripSection(parsed.body, "Memory Status")}\n## Memory Status\n\n- status: ${status}\n- reason: ${reason}\n`;
		await writeText(path, `${frontmatter(parsed.data)}${body}`);
	}

	async sync(message = `memory(sync): ${new Date().toISOString()}`): Promise<MemorySyncResult> {
		await git(this.paths.root, "add", "-A");
		const staged = await git(this.paths.root, "diff", "--cached", "--name-only");
		if (!staged.stdout.trim()) return { status: "clean" };

		await git(this.paths.root, "commit", "-m", message);
		const commit = (await git(this.paths.root, "rev-parse", "--short", "HEAD")).stdout.trim();
		await git(this.paths.root, "push");
		return { status: "pushed", commit };
	}

	private async corpus(): Promise<CorpusDoc[]> {
		const docs: CorpusDoc[] = [];
		await this.addDirDocs(docs, this.paths.semantic, "semantic");
		await this.addDirDocs(docs, this.paths.world, "world");
		await this.addDirDocs(docs, this.paths.topics, "topic");
		await this.addDirDocs(docs, this.paths.ideas, "idea");
		await this.addFileDoc(docs, this.paths.contextFile, "narrative");
		await this.addFileDoc(docs, this.paths.becoming, "becoming");
		await this.addDirDocs(docs, this.paths.recognitions, "recognition");
		return docs;
	}

	private async addDirDocs(docs: CorpusDoc[], dir: string, kind: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort()) {
			if (entry.endsWith(".md")) await this.addFileDoc(docs, join(dir, entry), kind);
		}
	}

	private async addFileDoc(docs: CorpusDoc[], path: string, kind: string): Promise<void> {
		const text = await readText(path);
		if (!text?.trim()) return;
		docs.push({ id: `${kind}/${basename(path, ".md")}`, kind, path, text });
	}

	private async staleBanner(): Promise<string> {
		const state = await readJson<{ last_synthesize?: string }>(this.paths.stateFile, {});
		if (!state.last_synthesize) return "";
		const last = new Date(state.last_synthesize.slice(0, 10));
		if (Number.isNaN(last.getTime())) return "";
		const days = Math.floor((Date.now() - last.getTime()) / 86400000);
		return days > this.config.cadence.synthesizeStaleAfterDays
			? `> Weekly review skipped ${days} days - narrative may be stale.\n\n`
			: "";
	}

	private async episodesSince(cursor: string | null): Promise<Array<{ ts: string; id: string; text: string }>> {
		const entries = await markdownEntries(this.paths.raw);
		const episodes: Array<{ ts: string; id: string; text: string }> = [];
		for (const entry of entries) {
			const path = join(this.paths.raw, entry);
			const parsed = parseFrontmatter(await readText(path));
			const ts = String(parsed.data.timestamp ?? entry.split("--")[0]);
			if (cursor !== null && ts <= cursor) continue;
			episodes.push({ ts, id: String(parsed.data.id ?? entry.replace(/\.md$/, "")), text: parsed.body.trim() });
		}
		return episodes.sort((a, b) => a.ts.localeCompare(b.ts));
	}

	private async upsertNote(note: Record<string, unknown>): Promise<void> {
		const key = slug(String(note.key ?? note.title ?? "note"));
		const path = join(this.paths.semantic, `${key}.md`);
		const existing = parseFrontmatter(await readText(path));
		const existingSources = Array.isArray(existing.data.sources) ? existing.data.sources.map(String) : [];
		const incomingSources = Array.isArray(note.sources) ? note.sources.map(String) : [];
		const sources = [...new Set([...existingSources, ...incomingSources])].sort();
		const type = typeof note.type === "string" && UNIT_TYPES.has(note.type) ? note.type : "note";
		const relations = normalizeRelations(note);
		const fm = {
			key,
			type,
			created: existing.data.created ?? today(),
			updated: today(),
			sources,
			relations,
		};
		const content = typeof note.content === "string" ? note.content : "";
		const relationBody =
			relations.length > 0
				? `\n\n## Relations\n${relations.map((relation) => `- ${relation.rel}: [[${relation.to}]]`).join("\n")}\n`
				: "\n";
		await writeText(path, `${frontmatter(fm)}${content.trimEnd()}${relationBody}`);
	}

	private async noteSummaries(): Promise<Array<{ key: string; kind: string; type: string; title: string }>> {
		const out: Array<{ key: string; kind: string; type: string; title: string }> = [];
		for (const [dir, kind] of [
			[this.paths.semantic, "semantic"],
			[this.paths.world, "world"],
		] as const) {
			for (const entry of await markdownEntries(dir)) {
				const text = (await readText(join(dir, entry))) ?? "";
				const parsed = parseFrontmatter(text);
				const title = parsed.body
					.split(/\r?\n/)
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim();
				out.push({
					key: entry.replace(/\.md$/, ""),
					kind,
					type: typeof parsed.data.type === "string" ? parsed.data.type : "note",
					title: title || entry.replace(/\.md$/, ""),
				});
			}
		}
		return out;
	}

	private async topicSummaries(): Promise<string[]> {
		const lines: string[] = [];
		for (const entry of await markdownEntries(this.paths.topics)) {
			const parsed = parseFrontmatter(await readText(join(this.paths.topics, entry)));
			const members = Array.isArray(parsed.data.members) ? parsed.data.members.join(", ") : "";
			lines.push(`- ${String(parsed.data.theme ?? entry.replace(/\.md$/, ""))}: ${members}`);
		}
		return lines;
	}

	private async existingIdeaTitles(): Promise<string[]> {
		const titles: string[] = [];
		for (const entry of await markdownEntries(this.paths.ideas)) {
			const body = parseFrontmatter(await readText(join(this.paths.ideas, entry))).body;
			titles.push(
				body
					.split(/\r?\n/)
					.find((line) => line.startsWith("# "))
					?.slice(2)
					.trim() ?? entry.replace(/\.md$/, ""),
			);
		}
		return titles;
	}

	private async markRecognitionAnswered(ref: string, episodeId: string): Promise<void> {
		let entries: string[];
		try {
			entries = await readdir(this.paths.recognitions);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const path = join(this.paths.recognitions, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.id !== ref) continue;
			parsed.data.status = "answered";
			parsed.data.response_episode = episodeId;
			await writeText(path, `${frontmatter(parsed.data)}${parsed.body}`);
			return;
		}
	}

	private async findWorldNote(noteId: string): Promise<string> {
		const entries = await readdir(this.paths.world);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const path = join(this.paths.world, entry);
			const parsed = parseFrontmatter(await readText(path));
			if (parsed.data.id === noteId || basename(entry, ".md") === noteId) return path;
		}
		throw new Error(`world note not found: ${noteId}`);
	}
}

export async function initStore(root: string): Promise<StorePaths> {
	const paths = new StorePaths(root);
	for (const dir of [
		paths.raw,
		paths.semantic,
		paths.narrative,
		paths.recognitions,
		paths.proposals,
		paths.world,
		paths.topics,
		paths.ideas,
		paths.herDir,
	]) {
		await mkdir(dir, { recursive: true });
	}
	await writeText(paths.configFile, renderConfig());
	await writeJson(paths.stateFile, { cursor: null, last_consolidate: null, last_synthesize: null });
	await writeText(paths.contextFile, SEED_CONTEXT);
	await writeText(join(paths.root, ".gitignore"), "# secrets - never commit\n.env\n.her/lock\n");
	await writeText(join(paths.root, ".env.example"), "HER_LLM_API_KEY=your-key-here\n");
	return paths;
}

function episodeSection(
	sid: string,
	ts: string,
	project: string,
	summary: string,
	rawStem: string,
	pending: boolean,
): string {
	return `\n## ${sid} · ${ts.replace("T", " ")} · project: ${project}\n${summary}\n- raw: [[episodic/raw/${rawStem}]]\n- summary_pending: ${String(pending)}\n`;
}

function worldBody(data: WorldNoteData): string {
	return `# ${data.title}

## Extracted Content

${data.extracted}

## Coverage

${data.coverage}

## Samantha's Read

${data.read}

## What To Steal

${data.steal.map((item) => `- ${item}`).join("\n")}

## Connections

${data.connections.map((item) => `- [[${item}]]`).join("\n")}

## Samantha's Take

${data.take}

## Possible Moves

${data.possibleMoves.map((item) => `- ${item}`).join("\n")}

## Judgment Trail

`;
}

function appendJudgment(body: string, fields: JudgmentFields): string {
	const heading = "## Judgment Trail";
	const entry = [`### ${new Date().toISOString()}`];
	for (const [key, value] of Object.entries(fields)) {
		if (value) entry.push(`- ${snakeCase(key)}: ${value}`);
	}
	const block = `${entry.join("\n")}\n`;
	if (body.includes(heading)) return `${body.trimEnd()}\n\n${block}`;
	return `${body.trimEnd()}\n\n${heading}\n\n${block}`;
}

function stripSection(body: string, heading: string): string {
	const pattern = new RegExp(`\\n?## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`, "m");
	return body.replace(pattern, "").trimEnd();
}

function genId(seedA: string, seedB: string): string {
	return createHash("sha1").update(`${seedA}${seedB}`).digest("hex").slice(0, 8);
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "note"
	);
}

function safeStem(text: string): string {
	return text.replace(/[^A-Za-z0-9._-]/g, "_") || "x";
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

function extractJson<T>(text: string): T {
	let source = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(source);
	if (fence) source = fence[1].trim();
	return JSON.parse(source) as T;
}

async function markdownEntries(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((entry) => entry.endsWith(".md")).sort();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

async function markdownStems(dir: string): Promise<string[]> {
	return (await markdownEntries(dir)).map((entry) => entry.replace(/\.md$/, ""));
}

async function readMarkdownDir(dir: string): Promise<string> {
	const chunks = [];
	for (const entry of await markdownEntries(dir)) {
		chunks.push((await readText(join(dir, entry))) ?? "");
	}
	return chunks.join("\n\n");
}

function normalizeRelations(note: Record<string, unknown>): Array<{ to: string; rel: string }> {
	const raw =
		Array.isArray(note.relations) && note.relations.length > 0
			? note.relations
			: Array.isArray(note.links)
				? note.links.map((link) => ({ to: link, rel: "relates" }))
				: [];
	const out: Array<{ to: string; rel: string }> = [];
	for (const item of raw) {
		const record: Record<string, unknown> =
			item && typeof item === "object" ? (item as Record<string, unknown>) : { to: item };
		const to = slug(String(record.to ?? ""));
		if (!to) continue;
		const rawRel = String(record.rel ?? "relates");
		out.push({ to, rel: RELATION_TYPES.has(rawRel) ? rawRel : "relates" });
	}
	return out;
}

function timestampMinute(): string {
	return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "T");
}

function snakeCase(text: string): string {
	return text.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
