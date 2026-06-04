import type { ModelLike } from "./her-core/index.ts";

interface SummaryConfig {
	baseUrl: string;
	apiKey?: string;
	model: string;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
}

export function createSummaryModel(env: NodeJS.ProcessEnv = process.env): ModelLike | undefined {
	const config = readSummaryConfig(env);
	if (!config) return undefined;
	return {
		async complete(prompt) {
			return await completeChat(config, prompt);
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

	const deepseekKey = value(env.HER_DEEPSEEK_KEY);
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

async function completeChat(config: SummaryConfig, prompt: string): Promise<string> {
	const response = await fetch(chatCompletionsUrl(config.baseUrl), {
		method: "POST",
		headers: headers(config.apiKey),
		body: JSON.stringify({
			model: config.model,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.2,
			max_tokens: 700,
		}),
	});
	if (!response.ok) {
		throw new Error(`summary model failed: HTTP ${response.status}`);
	}
	const data = (await response.json()) as ChatCompletionResponse;
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string" || !content.trim()) {
		throw new Error("summary model returned empty content");
	}
	return content.trim();
}

function chatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/chat/completions")) return trimmed;
	return `${trimmed}/chat/completions`;
}

function headers(apiKey: string | undefined): Record<string, string> {
	const result: Record<string, string> = { "content-type": "application/json" };
	if (apiKey) result.authorization = `Bearer ${apiKey}`;
	return result;
}

function value(text: string | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed ? trimmed : undefined;
}
