import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { StorePaths } from "./paths.ts";
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

export const SEED_CONTEXT =
	"# CONTEXT - Living Narrative / alive narrative\n\n*(empty - Samantha has not yet formed an understanding of Fei.)*\n";

export interface ModelLike {
	complete(prompt: string, options?: { strong?: boolean }): Promise<string> | string;
}

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

export class Memory {
	readonly paths: StorePaths;
	private readonly model?: ModelLike;

	constructor(root: string, model?: ModelLike) {
		this.paths = new StorePaths(root);
		this.model = model;
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
		return days > 10 ? `> Weekly review skipped ${days} days - narrative may be stale.\n\n` : "";
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
	await writeText(paths.configFile, "cadence:\n  synthesize_stale_after_days: 10\n");
	await writeJson(paths.stateFile, { cursor: null, last_consolidate: null, last_synthesize: null });
	await writeText(paths.contextFile, SEED_CONTEXT);
	await writeText(join(paths.root, ".gitignore"), "# secrets - never commit\n.env\n.her/lock\n");
	await writeText(join(paths.root, ".env.example"), "HER_LLM_API_KEY=your-key-here\n");
	return paths;
}

function summaryPrompt(raw: string): string {
	return `Summarize this memory episode:\n\n${raw}`;
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

function timestampMinute(): string {
	return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "T");
}

function snakeCase(text: string): string {
	return text.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
