import { readFileSync } from "node:fs";

export interface HerConfig {
	llm: {
		baseUrl: string;
		modelFast: string;
		modelStrong: string;
		apiKeyEnv: string;
	};
	cadence: {
		consolidate: string;
		synthesize: string;
		synthesizeStaleAfterDays: number;
	};
}

export const DEFAULT_CONFIG: HerConfig = {
	llm: {
		baseUrl: "https://api.deepseek.com",
		modelFast: "deepseek-v4-flash",
		modelStrong: "deepseek-v4-pro",
		apiKeyEnv: "HER_LLM_API_KEY",
	},
	cadence: {
		consolidate: "daily",
		synthesize: "weekly",
		synthesizeStaleAfterDays: 10,
	},
};

export function loadConfig(path: string): HerConfig {
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return cloneConfig(DEFAULT_CONFIG);
		}
		throw error;
	}
	return mergeConfig(DEFAULT_CONFIG, parseConfigYaml(text));
}

export function renderConfig(config: HerConfig = DEFAULT_CONFIG): string {
	return [
		"llm:",
		`  base_url: ${config.llm.baseUrl}`,
		`  model_fast: ${config.llm.modelFast}`,
		`  model_strong: ${config.llm.modelStrong}`,
		`  api_key_env: ${config.llm.apiKeyEnv}`,
		"cadence:",
		`  consolidate: ${config.cadence.consolidate}`,
		`  synthesize: ${config.cadence.synthesize}`,
		`  synthesize_stale_after_days: ${config.cadence.synthesizeStaleAfterDays}`,
		"",
	].join("\n");
}

function mergeConfig(base: HerConfig, overrides: Partial<HerConfig>): HerConfig {
	return {
		llm: { ...base.llm, ...(overrides.llm ?? {}) },
		cadence: { ...base.cadence, ...(overrides.cadence ?? {}) },
	};
}

function cloneConfig(config: HerConfig): HerConfig {
	return mergeConfig(config, {});
}

function parseConfigYaml(text: string): Partial<HerConfig> {
	const out: Record<string, Record<string, unknown>> = {};
	let section: string | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "");
		if (!line.trim()) continue;
		const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (top && !rawLine.startsWith(" ")) {
			section = top[1];
			if (!out[section]) out[section] = {};
			if (top[2].trim()) out[section]._value = parseScalar(top[2]);
			continue;
		}
		const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!nested || !section) continue;
		out[section][camel(nested[1])] = parseScalar(nested[2]);
	}
	return out as Partial<HerConfig>;
}

function parseScalar(raw: string): string | number | boolean {
	const text = raw.trim();
	if (text === "true") return true;
	if (text === "false") return false;
	if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
	return text.replace(/^["']|["']$/g, "");
}

function camel(text: string): string {
	return text.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}
