import type { HerConfig } from "./config.ts";

export interface ModelLike {
	complete(prompt: string, options?: { strong?: boolean }): Promise<string> | string;
}

export class FakeModel implements ModelLike {
	readonly calls: Array<{ prompt: string; strong: boolean }> = [];
	private readonly reply: string;
	private readonly fail: boolean;

	constructor(reply = "- what: test\n- decisions: none\n- signals: none", fail = false) {
		this.reply = reply;
		this.fail = fail;
	}

	complete(prompt: string, options: { strong?: boolean } = {}): string {
		this.calls.push({ prompt, strong: options.strong === true });
		if (this.fail) throw new Error("model unavailable (FakeModel.fail=true)");
		return this.reply;
	}
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
		};
	}>;
}

export class OpenAICompatibleModel implements ModelLike {
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

	async complete(prompt: string, options: { strong?: boolean } = {}): Promise<string> {
		const key = this.env[this.config.llm.apiKeyEnv];
		if (!key) throw new Error(`Missing API key: set ${this.config.llm.apiKeyEnv}`);
		const response = await this.fetcher(chatCompletionsUrl(this.config.llm.baseUrl), {
			method: "POST",
			headers: new Headers({
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			}),
			body: JSON.stringify({
				model: options.strong ? this.config.llm.modelStrong : this.config.llm.modelFast,
				messages: [{ role: "user", content: prompt }],
			}),
		});
		if (!response.ok) throw new Error(`model request failed: HTTP ${response.status}`);
		const data = (await response.json()) as ChatCompletionResponse;
		const content = data.choices?.[0]?.message?.content;
		if (typeof content !== "string" || !content.trim()) throw new Error("model returned empty content");
		return content.trim();
	}
}

function chatCompletionsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	if (trimmed.endsWith("/chat/completions")) return trimmed;
	return `${trimmed}/chat/completions`;
}
