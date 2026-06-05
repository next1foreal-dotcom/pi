const wordPattern = /[a-z0-9]+/g;
const cjkPattern = /[\u4e00-\u9fff]/g;

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

export async function rrfSearch(query: string, docs: CorpusDoc[], opts: RrfSearchOptions = {}): Promise<Note[]> {
	const k = opts.k ?? 5;
	const poolSize = opts.poolSize ?? Math.max(k * 4, 20);
	const lexical = lexicalSearch(query, docs, poolSize);
	const semantic = opts.semanticSearch ? await opts.semanticSearch(query, docs, poolSize) : [];
	return reciprocalRankFusion([lexical, semantic], { k, rrfK: opts.rrfK });
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
