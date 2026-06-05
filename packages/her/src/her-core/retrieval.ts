import { DatabaseSync } from "node:sqlite";

const wordPattern = /[a-z0-9]+/g;
const cjkPattern = /[\u4e00-\u9fff]/g;
const titledPhrasePattern = /\b[A-Z][A-Za-z0-9]*(?:[-\s][A-Z][A-Za-z0-9]*)*\b/g;

export interface CorpusDoc {
	id: string;
	kind: string;
	path: string;
	text: string;
}

export interface Note extends CorpusDoc {
	score: number;
}

export type SearchBackend = (query: string, docs: CorpusDoc[], k: number) => Promise<Note[]> | Note[];

export interface RrfSearchOptions {
	k?: number;
	poolSize?: number;
	rrfK?: number;
	semanticSearch?: SearchBackend;
}

function tokens(text: string): string[] {
	const lower = text.toLowerCase();
	return [...(lower.match(wordPattern) ?? []), ...(lower.match(cjkPattern) ?? [])];
}

export function lexicalSearch(query: string, docs: CorpusDoc[], k = 5): Note[] {
	const queryTokens = new Set(tokens(query));
	if (queryTokens.size === 0) return [];

	return docs
		.map((doc) => {
			const docTokens = tokens(doc.text);
			const hits = docTokens.filter((token) => queryTokens.has(token)).length;
			const score = hits / Math.max(docTokens.length, 1);
			return { ...doc, score };
		})
		.filter((doc) => doc.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, k);
}

export function ftsSearch(query: string, docs: CorpusDoc[], k = 8): Note[] {
	const matchQuery = ftsMatchQuery(query);
	if (!matchQuery || docs.length === 0) return [];
	const byId = new Map(docs.map((doc) => [doc.id, doc]));
	const db = new DatabaseSync(":memory:");
	try {
		db.exec("CREATE VIRTUAL TABLE docs USING fts5(id UNINDEXED, kind UNINDEXED, path UNINDEXED, text)");
		const insert = db.prepare("INSERT INTO docs(id, kind, path, text) VALUES (?, ?, ?, ?)");
		for (const doc of docs) insert.run(doc.id, doc.kind, doc.path, `${doc.id}\n${doc.path}\n${doc.text}`);
		const rows = db
			.prepare("SELECT id FROM docs WHERE docs MATCH ? ORDER BY rank LIMIT ?")
			.all(matchQuery, k) as Array<{ id: string }>;
		return rows
			.map((row, index) => {
				const doc = byId.get(row.id);
				return doc ? { ...doc, score: 1 / (index + 1) } : undefined;
			})
			.filter((note): note is Note => Boolean(note));
	} catch {
		return [];
	} finally {
		db.close();
	}
}

export function entitySearch(query: string, docs: CorpusDoc[], k = 8): Note[] {
	const queryTerms = entityTerms(query);
	if (queryTerms.size === 0) return [];
	return docs
		.map((doc) => {
			const docTerms = entityTerms(`${doc.id} ${doc.path} ${headingText(doc.text)}`);
			let hits = 0;
			for (const term of queryTerms) {
				if (docTerms.has(term)) hits++;
			}
			return { ...doc, score: hits / queryTerms.size };
		})
		.filter((doc) => doc.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, k);
}

export async function rrfSearch(query: string, docs: CorpusDoc[], opts: RrfSearchOptions = {}): Promise<Note[]> {
	const k = opts.k ?? 8;
	const poolSize = opts.poolSize ?? Math.max(k * 4, 20);
	const fts = ftsSearch(query, docs, poolSize);
	const lexical = fts.length > 0 ? fts : lexicalSearch(query, docs, poolSize);
	const entities = entitySearch(query, docs, poolSize);
	const semantic = opts.semanticSearch ? await opts.semanticSearch(query, docs, poolSize) : [];
	return reciprocalRankFusion([lexical, semantic, entities], { k, rrfK: opts.rrfK });
}

export function reciprocalRankFusion(rankings: Note[][], opts: { k?: number; rrfK?: number } = {}): Note[] {
	const k = opts.k ?? 5;
	const rrfK = opts.rrfK ?? 60;
	const byId = new Map<string, Note>();
	const scores = new Map<string, number>();

	for (const ranking of rankings) {
		ranking.forEach((note, index) => {
			byId.set(note.id, note);
			scores.set(note.id, (scores.get(note.id) ?? 0) + 1 / (rrfK + index + 1));
		});
	}

	return [...byId.values()]
		.map((note) => ({ ...note, score: scores.get(note.id) ?? 0 }))
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
		.slice(0, k);
}

function ftsMatchQuery(text: string): string {
	const terms = [...new Set(tokens(text))]
		.map((token) => token.replace(/"/g, ""))
		.filter(Boolean)
		.map((token) => `"${token}"`);
	return terms.join(terms.length > 1 ? " AND " : " OR ");
}

function entityTerms(text: string): Set<string> {
	const terms = new Set<string>();
	for (const token of tokens(text)) {
		if (token.length >= 3 || /[\u4e00-\u9fff]/.test(token)) terms.add(token);
	}
	for (const phrase of text.match(titledPhrasePattern) ?? []) {
		const normalized = phrase
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (normalized) terms.add(normalized);
		for (const token of tokens(phrase)) {
			if (token.length >= 2) terms.add(token);
		}
	}
	return terms;
}

function headingText(markdown: string): string {
	return markdown
		.split(/\r?\n/)
		.filter((line) => /^#{1,3}\s+/.test(line))
		.join("\n");
}
