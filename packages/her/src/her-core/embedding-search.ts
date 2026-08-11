import type { CorpusDoc, Note, SearchBackend } from "./retrieval.ts";

interface EmbeddingSearchConfig {
	apiKey?: string;
	baseUrl: string;
	maxDocChars: number;
	model: string;
	timeoutMs: number;
}

/**
 * A silent endpoint would otherwise inherit Node's fixed 300s headers deadline,
 * which stalls recall for five minutes and reads like the store is broken.
 */
const DEFAULT_EMBEDDINGS_TIMEOUT_MS = 30_000;

interface EmbeddingsResponse {
	data?: Array<{ embedding?: unknown }>;
}

export function createEmbeddingSearch(
	env: Record<string, string | undefined> = process.env,
	fetcher: typeof fetch = fetch,
): SearchBackend | undefined {
	const config = readEmbeddingConfig(env);
	if (!config) return undefined;
	return async (query, docs, k) => {
		const inputs = [query, ...docs.map((doc) => docEmbeddingText(doc, config.maxDocChars))];
		const embeddings = await embed(config, inputs, fetcher);
		const queryEmbedding = embeddings[0];
		if (!queryEmbedding) return [];
		return docs
			.map((doc, index) => {
				const docEmbedding = embeddings[index + 1];
				if (!docEmbedding) return undefined;
				return { ...doc, score: cosineSimilarity(queryEmbedding, docEmbedding) };
			})
			.filter((note): note is Note => Boolean(note))
			.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
			.slice(0, k);
	};
}

function readEmbeddingConfig(env: Record<string, string | undefined>): EmbeddingSearchConfig | undefined {
	const baseUrl = value(env.HER_EMBEDDINGS_BASE_URL);
	const model = value(env.HER_EMBEDDINGS_MODEL);
	if (!baseUrl || !model) return undefined;
	return {
		apiKey: value(env.HER_EMBEDDINGS_API_KEY),
		baseUrl,
		maxDocChars: positiveNumber(env.HER_EMBEDDINGS_MAX_DOC_CHARS, 6000),
		model,
		timeoutMs: positiveNumber(env.HER_EMBEDDINGS_TIMEOUT_MS, DEFAULT_EMBEDDINGS_TIMEOUT_MS),
	};
}

async function embed(config: EmbeddingSearchConfig, input: string[], fetcher: typeof fetch): Promise<number[][]> {
	const response = await fetcher(embeddingsUrl(config.baseUrl), {
		method: "POST",
		headers: headers(config.apiKey),
		body: JSON.stringify({ input, model: config.model }),
		signal: AbortSignal.timeout(config.timeoutMs),
	});
	if (!response.ok) throw new Error(`embedding search failed: HTTP ${response.status}`);
	const data = (await response.json()) as EmbeddingsResponse;
	return (data.data ?? []).map((item) => vector(item.embedding));
}

function vector(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
}

function docEmbeddingText(doc: CorpusDoc, maxChars: number): string {
	return [`id: ${doc.id}`, `kind: ${doc.kind}`, doc.text].join("\n").slice(0, maxChars);
}

function cosineSimilarity(a: number[], b: number[]): number {
	const length = Math.min(a.length, b.length);
	if (length === 0) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let index = 0; index < length; index++) {
		dot += a[index] * b[index];
		magA += a[index] ** 2;
		magB += b[index] ** 2;
	}
	if (magA === 0 || magB === 0) return 0;
	return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function embeddingsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/embeddings")) return trimmed;
	return `${trimmed}/embeddings`;
}

function headers(apiKey: string | undefined): Headers {
	const result = new Headers({ connection: "close", "content-type": "application/json" });
	if (apiKey) result.set("authorization", `Bearer ${apiKey}`);
	return result;
}

function positiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function value(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}
