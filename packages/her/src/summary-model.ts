import type { CompletionOptions, CompletionResult, CompletionUsage, ModelLike } from "./her-core/index.ts";

interface SummaryConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
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

export function createSummaryModel(env: NodeJS.ProcessEnv = process.env): ModelLike | undefined {
	const config = readSummaryConfig(env);
	if (!config) return undefined;
	return {
		async complete(prompt, options) {
			return (await this.completeWithMeta!(prompt, options)).text;
		},
		async completeWithMeta(prompt, options) {
			const result = await completeChat(config, prompt, options);
			this.lastCompletion = {
				...(result.finishReason ? { finishReason: result.finishReason } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(result.model ? { model: result.model } : {}),
				...(result.provider ? { provider: result.provider } : {}),
			};
			return result;
		},
	};
}

function readSummaryConfig(env: NodeJS.ProcessEnv): SummaryConfig | undefined {
	const explicitBaseUrl = value(env.HER_SUMMARY_BASE_URL);
	const explicitModel = value(env.HER_SUMMARY_MODEL);
	const explicitApiKey = value(env.HER_SUMMARY_API_KEY) ?? value(env.HER_LLM_API_KEY);
	if (explicitBaseUrl && explicitModel) {
		return { baseUrl: explicitBaseUrl, apiKey: explicitApiKey, model: explicitModel };
	}

	const relayUrl = value(env.HER_RELAY_URL);
	const relayKey = value(env.HER_RELAY_KEY);
	if (relayUrl && relayKey) {
		return {
			baseUrl: relayUrl,
			apiKey: relayKey,
			model: explicitModel ?? value(env.HER_RELAY_MODEL) ?? "her-relay-default",
		};
	}

	const deepseekKey = value(env.HER_DEEPSEEK_KEY) ?? value(env.DEEPSEEK_API_KEY) ?? value(env.HER_LLM_API_KEY);
	if (deepseekKey) {
		return {
			baseUrl: value(env.HER_DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com",
			apiKey: deepseekKey,
			model: explicitModel ?? value(env.HER_DEEPSEEK_MODEL) ?? "deepseek-chat",
		};
	}

	const localUrl = value(env.HER_LOCAL_OPENAI_URL);
	if (localUrl) {
		return {
			baseUrl: localUrl,
			apiKey: value(env.HER_LOCAL_OPENAI_KEY),
			model: explicitModel ?? value(env.HER_LOCAL_OPENAI_MODEL) ?? "local-default",
		};
	}

	return undefined;
}

async function completeChat(
	config: SummaryConfig,
	prompt: string,
	options?: CompletionOptions,
): Promise<CompletionResult> {
	const maxTokens = typeof options?.maxTokens === "number" && options.maxTokens > 0 ? options.maxTokens : 700;
	const response = await fetch(chatCompletionsUrl(config.baseUrl), {
		method: "POST",
		headers: headers(config.apiKey),
		body: JSON.stringify({
			model: config.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.2,
			max_tokens: maxTokens,
		}),
		...(options?.signal ? { signal: options.signal } : {}),
	});
	if (!response.ok) {
		throw new Error(`summary model failed: HTTP ${response.status}`);
	}
	const data = (await response.json()) as ChatCompletionResponse;
	const finishReason =
		typeof data.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : undefined;
	const usage = sanitizeUsage(data.usage);
	const provider = providerHost(config.baseUrl);
	const reportedModel = typeof data.model === "string" && data.model.trim() ? data.model : config.model;
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error("summary model returned empty content");
	}
	return {
		text: content.trim(),
		...(finishReason ? { finishReason } : {}),
		...(usage ? { usage } : {}),
		model: reportedModel,
		provider,
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

function headers(apiKey: string | undefined): Record<string, string> {
	const result: Record<string, string> = { connection: "close", "content-type": "application/json" };
	if (apiKey) result.authorization = `Bearer ${apiKey}`;
	return result;
}

function value(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}
