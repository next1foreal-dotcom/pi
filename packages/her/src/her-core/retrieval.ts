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
