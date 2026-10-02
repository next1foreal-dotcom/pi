import type { HerConfig } from "./config.ts";
import { fetchModel } from "./model-fetch.ts";

export interface CompletionUsage {
	completion_tokens?: number;
	prompt_tokens?: number;
	total_tokens?: number;
}

export interface CompletionDiagnostics {
	responseId?: string;
	httpStatus: number;
	choiceCount: number;
	contentBytes: number;
	reasoningBytes: number;
	modelIdentity: "reported" | "requested-fallback";
	usageStatus: "complete" | "partial" | "invalid" | "missing";
}

export type CompletionResponseCode =
	| "http_error"
	| "invalid_json"
	| "invalid_response"
	| "missing_choice"
	| "invalid_content"
	| "empty_content"
	| "reasoning_only"
	| "reasoning_only_length"
	| "incomplete_response"
	| "missing_model_identity";

export interface CompletionMeta {
	diagnostics?: CompletionDiagnostics;
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
	/** Explicit per-call choices only; undefined leaves provider defaults unchanged. */
	thinking?: "enabled" | "disabled";
	reasoningEffort?: "low" | "high" | "max";
	responseFormat?: "json_object";
	/** Require a final stop response; legacy callers may handle partial output themselves. */
	requireComplete?: boolean;
	/** Disable even connection-establishment retries for owner-authorized one-shot calls. */
	singleRequest?: boolean;
};

export interface ModelLike {
	complete(prompt: string, options?: CompletionOptions): Promise<string> | string;
	completeWithMeta?(prompt: string, options?: CompletionOptions): Promise<CompletionResult> | CompletionResult;
	lastCompletion?: CompletionMeta;
}

/** Metadata belongs to this failed request, never a later lastCompletion value.
 * Only field sizes are retained for reasoning; its content is never an answer or a log.
 */
export class CompletionResponseError extends Error {
	readonly code: CompletionResponseCode;
	readonly meta: Readonly<CompletionMeta>;
	constructor(code: CompletionResponseCode, meta: CompletionMeta) {
		const label =
			code === "empty_content"
				? "model returned empty content"
				: code === "http_error"
					? `model request failed: HTTP ${meta.diagnostics?.httpStatus ?? "unknown"}`
					: `model response rejected: ${code}`;
		super(
			`${label}; finish=${meta.finishReason ?? "unknown"}; contentBytes=${meta.diagnostics?.contentBytes ?? 0}; reasoningBytes=${meta.diagnostics?.reasoningBytes ?? 0}`,
		);
		this.name = "CompletionResponseError";
		this.code = code;
		this.meta = Object.freeze({
			...meta,
			...(meta.usage ? { usage: Object.freeze({ ...meta.usage }) } : {}),
			...(meta.diagnostics ? { diagnostics: Object.freeze({ ...meta.diagnostics }) } : {}),
		});
	}
}

export function validateCompletionOptions(options: CompletionOptions): void {
	if (options.singleRequest !== undefined && typeof options.singleRequest !== "boolean")
		throw new Error("singleRequest must be a boolean");
	if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0))
		throw new Error("maxTokens must be a positive safe integer");
	if (options.thinking !== undefined && options.thinking !== "enabled" && options.thinking !== "disabled")
		throw new Error("thinking must be enabled or disabled");
	if (options.reasoningEffort !== undefined && !["low", "high", "max"].includes(options.reasoningEffort))
		throw new Error("invalid reasoningEffort");
	if (options.thinking === "disabled" && options.reasoningEffort !== undefined)
		throw new Error("disabled thinking cannot also request reasoning effort");
	if (options.responseFormat !== undefined && options.responseFormat !== "json_object")
		throw new Error("responseFormat must be json_object");
	if (options.requireComplete !== undefined && typeof options.requireComplete !== "boolean")
		throw new Error("requireComplete must be a boolean");
}

export function assertCompleteResponse(result: CompletionResult): void {
	if (result.finishReason !== "stop") throw new CompletionResponseError("incomplete_response", metaFromResult(result));
	if (result.diagnostics?.modelIdentity === "requested-fallback")
		throw new CompletionResponseError("missing_model_identity", metaFromResult(result));
	if (typeof result.text !== "string" || !result.text.trim())
		throw new CompletionResponseError("empty_content", metaFromResult(result));
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
	id?: unknown;
	choices?: Array<{
		finish_reason?: string | null;
		message?: {
			content?: unknown;
			reasoning_content?: unknown;
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
		this.lastCompletion = undefined;
		validateCompletionOptions(options);
		const key = this.env[this.config.llm.apiKeyEnv];
		if (!key) throw new Error(`Missing API key: set ${this.config.llm.apiKeyEnv}`);
		const modelName = options.strong ? this.config.llm.modelStrong : this.config.llm.modelFast;
		const request: RequestInit = {
			method: "POST",
			headers: new Headers({
				authorization: `Bearer ${key}`,
				connection: "close",
				"content-type": "application/json",
			}),
			body: JSON.stringify({
				model: modelName,
				messages: [{ role: "user", content: prompt }],
				...(options.thinking ? { thinking: { type: options.thinking } } : {}),
				...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
				...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
				...(typeof options.maxTokens === "number" && options.maxTokens > 0
					? { max_tokens: options.maxTokens }
					: {}),
			}),
			...(options.signal ? { signal: options.signal } : {}),
		};
		const url = chatCompletionsUrl(this.config.llm.baseUrl);
		const response = options.singleRequest
			? await this.fetcher(url, { ...request, redirect: "error" })
			: await fetchModel(this.fetcher, url, request);
		let meta: CompletionMeta = {
			model: modelName,
			provider: providerHost(this.config.llm.baseUrl),
			diagnostics: {
				httpStatus: response.status,
				choiceCount: 0,
				contentBytes: 0,
				reasoningBytes: 0,
				modelIdentity: "requested-fallback",
				usageStatus: "missing",
			},
		};
		this.lastCompletion = meta;
		if (!response.ok) throw new CompletionResponseError("http_error", meta);
		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			// Do not log a server body or retry a request that may already be billed.
			throw new CompletionResponseError("invalid_json", meta);
		}
		if (!isRecord(raw) || (raw.choices !== undefined && !Array.isArray(raw.choices)))
			throw new CompletionResponseError("invalid_response", meta);
		const data = raw as ChatCompletionResponse;
		const first = data.choices?.[0];
		const message = isRecord(first) && isRecord(first.message) ? first.message : undefined;
		const content = message?.content;
		const reasoning = message?.reasoning_content;
		const finishReason = safeLabel(first?.finish_reason);
		const usage = sanitizeUsage(data.usage);
		const hasModel = typeof data.model === "string" && data.model.trim().length > 0;
		meta = {
			...(finishReason ? { finishReason } : {}),
			...(usage ? { usage } : {}),
			model: hasModel ? data.model! : modelName,
			provider: meta.provider,
			diagnostics: {
				...(safeLabel(data.id) ? { responseId: safeLabel(data.id) } : {}),
				httpStatus: response.status,
				choiceCount: data.choices?.length ?? 0,
				contentBytes: typeof content === "string" ? Buffer.byteLength(content) : 0,
				reasoningBytes: typeof reasoning === "string" ? Buffer.byteLength(reasoning) : 0,
				modelIdentity: hasModel ? "reported" : "requested-fallback",
				usageStatus: usageStatus(data.usage),
			},
		};
		this.lastCompletion = meta;
		if (!first) throw new CompletionResponseError("missing_choice", meta);
		if (content !== undefined && content !== null && typeof content !== "string")
			throw new CompletionResponseError("invalid_content", meta);
		if (typeof content !== "string" || !content.trim()) {
			const hasReasoning = typeof reasoning === "string" && reasoning.trim().length > 0;
			const code = hasReasoning
				? finishReason === "length"
					? "reasoning_only_length"
					: "reasoning_only"
				: "empty_content";
			throw new CompletionResponseError(code, meta);
		}
		const result = { text: content.trim(), ...meta };
		if (options.requireComplete) assertCompleteResponse(result);
		return result;
	}
}

export async function invokeCompletion(
	model: ModelLike,
	prompt: string,
	options: CompletionOptions = {},
): Promise<CompletionResult> {
	model.lastCompletion = undefined;
	validateCompletionOptions(options);
	if (typeof model.completeWithMeta === "function") {
		const result = await model.completeWithMeta(prompt, options);
		model.lastCompletion = metaFromResult(result);
		if (options.requireComplete) assertCompleteResponse(result);
		return result;
	}
	const text = await model.complete(prompt, options);
	const result: CompletionResult = { text, ...(model.lastCompletion as CompletionMeta | undefined) };
	model.lastCompletion = metaFromResult(result);
	if (options.requireComplete) assertCompleteResponse(result);
	return result;
}

function metaFromResult(result: CompletionResult): CompletionMeta {
	return {
		...(result.diagnostics ? { diagnostics: { ...result.diagnostics } } : {}),
		...(result.finishReason ? { finishReason: result.finishReason } : {}),
		...(result.usage ? { usage: result.usage } : {}),
		...(result.model ? { model: result.model } : {}),
		...(result.provider ? { provider: result.provider } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeLabel(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : undefined;
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function usageStatus(raw: unknown): CompletionDiagnostics["usageStatus"] {
	if (raw === undefined || raw === null) return "missing";
	if (!isRecord(raw)) return "invalid";
	const keys = ["prompt_tokens", "completion_tokens", "total_tokens"] as const;
	const present = keys.filter((key) => raw[key] !== undefined);
	if (present.some((key) => !isTokenCount(raw[key]))) return "invalid";
	if (present.length !== 3) return "partial";
	const sum = Number(raw.prompt_tokens) + Number(raw.completion_tokens);
	return Number.isSafeInteger(sum) && sum === raw.total_tokens ? "complete" : "invalid";
}

function sanitizeUsage(raw: unknown): CompletionUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const usage: CompletionUsage = {};
	for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const)
		if (isTokenCount(raw[key])) usage[key] = raw[key];
	// Preserve valid partial measurements, but never repair or invent a provider total.
	if (usageStatus(raw) === "invalid") delete usage.total_tokens;
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
