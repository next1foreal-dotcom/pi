import type { HerConfig } from "./config.ts";

export interface CompletionUsage {
	completion_tokens?: number;
	prompt_tokens?: number;
	total_tokens?: number;
}

export interface CompletionMeta {
	finishReason?: string;
	model?: string;
	provider?: string;
	usage?: CompletionUsage;
}

export interface CompletionResult extends CompletionMeta {
	text: string;
}

export type CompletionOptions = {
	strong?: boolean;
	maxTokens?: number;
	signal?: AbortSignal;
};

export interface ModelLike {
	complete(prompt: string, options?: CompletionOptions): Promise<string> | string;
	completeWithMeta?(prompt: string, options?: CompletionOptions): Promise<CompletionResult> | CompletionResult;
	lastCompletion?: CompletionMeta;
}

export class FinishReasonLengthError extends Error {
	readonly currentBytes: number;
	readonly draftBytes: number;
	readonly finishReason: string;

	constructor(opts: { currentBytes: number; draftBytes: number; finishReason: string; op?: string }) {
		const op = opts.op ?? "synthesize";
		super(
			`${op} aborted: finish_reason=${opts.finishReason} (draft ${opts.draftBytes} bytes, current CONTEXT.md ${opts.currentBytes} bytes); refusing to write proposal, CONTEXT.md, or last_synthesize`,
		);
		this.name = "FinishReasonLengthError";
		this.finishReason = opts.finishReason;
		this.draftBytes = opts.draftBytes;
		this.currentBytes = opts.currentBytes;
	}
}

export class FakeModel implements ModelLike {
	readonly calls: Array<{ prompt: string; strong: boolean; maxTokens?: number }> = [];
	lastCompletion?: CompletionMeta;
	private readonly reply: string;
	private readonly fail: boolean;
	private readonly meta: CompletionMeta;

	constructor(reply = "- what: test\n- decisions: none\n- signals: none", fail = false, meta: CompletionMeta = {}) {
		this.reply = reply;
		this.fail = fail;
		this.meta = meta;
	}

	complete(prompt: string, options: CompletionOptions = {}): string {
		return this.completeWithMeta(prompt, options).text;
	}

	completeWithMeta(prompt: string, options: CompletionOptions = {}): CompletionResult {
		this.calls.push(
			options.maxTokens === undefined
				? { prompt, strong: options.strong === true }
				: { prompt, strong: options.strong === true, maxTokens: options.maxTokens },
		);
		if (this.fail) throw new Error("model unavailable (FakeModel.fail=true)");
		this.lastCompletion = { ...this.meta };
		return { text: this.reply, ...this.lastCompletion };
	}
}

interface ChatCompletionResponse {
	choices?: Array<{
		finish_reason?: string | null;
		message?: {
			content?: unknown;
		};
	}>;
	model?: string;
	usage?: {
		completion_tokens?: number;
		prompt_tokens?: number;
		total_tokens?: number;
	};
}

export class OpenAICompatibleModel implements ModelLike {
	lastCompletion?: CompletionMeta;
	private readonly config: HerConfig;
	private readonly env: Record<string, string | undefined>;
	private readonly fetcher: typeof fetch;

	constructor(
		config: HerConfig,
		env: Record<string, string | undefined> = process.env,
		fetcher: typeof fetch = fetch,
	) {
		this.config = config;
		this.env = env;
		this.fetcher = fetcher;
	}

	async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
		return (await this.completeWithMeta(prompt, options)).text;
	}

	async completeWithMeta(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
		const key = this.env[this.config.llm.apiKeyEnv];
		if (!key) throw new Error(`Missing API key: set ${this.config.llm.apiKeyEnv}`);
		const modelName = options.strong ? this.config.llm.modelStrong : this.config.llm.modelFast;
		const response = await this.fetcher(chatCompletionsUrl(this.config.llm.baseUrl), {
			method: "POST",
			headers: new Headers({
				authorization: `Bearer ${key}`,
				connection: "close",
				"content-type": "application/json",
			}),
			body: JSON.stringify({
				model: modelName,
				messages: [{ role: "user", content: prompt }],
				...(typeof options.maxTokens === "number" && options.maxTokens > 0
					? { max_tokens: options.maxTokens }
					: {}),
			}),
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (!response.ok) throw new Error(`model request failed: HTTP ${response.status}`);
		const data = (await response.json()) as ChatCompletionResponse;
		const finishReason =
			typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : undefined;
		const usage = sanitizeUsage(data.usage);
		const provider = providerHost(this.config.llm.baseUrl);
		const reportedModel = typeof data.model === "string" && data.model.trim() ? data.model : modelName;
		this.lastCompletion = {
			...(finishReason ? { finishReason } : {}),
			...(usage ? { usage } : {}),
			model: reportedModel,
			provider,
		};
		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) throw new Error("model returned empty content");
		return { text: content.trim(), ...this.lastCompletion };
	}
}

export async function invokeCompletion(
	model: ModelLike,
	prompt: string,
	options: CompletionOptions = {},
): Promise<CompletionResult> {
	if (typeof model.completeWithMeta === "function") {
		const result = await model.completeWithMeta(prompt, options);
		model.lastCompletion = metaFromResult(result);
		return result;
	}
	const text = await model.complete(prompt, options);
	const result: CompletionResult = { text, ...model.lastCompletion };
	model.lastCompletion = metaFromResult(result);
	return result;
}

function metaFromResult(result: CompletionResult): CompletionMeta {
	return {
		...(result.finishReason ? { finishReason: result.finishReason } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.model ? { model: result.model } : {}),
		...(result.provider ? { provider: result.provider } : {}),
	};
}

function sanitizeUsage(raw: ChatCompletionResponse["usage"]): CompletionUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const usage: CompletionUsage = {};
	if (typeof raw.prompt_tokens === "number") usage.prompt_tokens = raw.prompt_tokens;
	if (typeof raw.completion_tokens === "number") usage.completion_tokens = raw.completion_tokens;
	if (typeof raw.total_tokens === "number") usage.total_tokens = raw.total_tokens;
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function providerHost(baseUrl: string): string {
	try {
		return new URL(chatCompletionsUrl(baseUrl)).host;
	} catch {
		return "openai-compatible";
	}
}

function chatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/chat/completions")) return trimmed;
	return `${trimmed}/chat/completions`;
}
