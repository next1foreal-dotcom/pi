import { join } from "node:path";
import type { StorePaths } from "./paths.ts";
import { appendText, readText, redactSecrets } from "./store.ts";

export const REFLEX_SIGNAL_NAMES = [
	"goal_relevance",
	"novelty",
	"urgency",
	"contradiction",
	"personal_significance",
	"recall_needed",
	"wake_system2",
	"interrupt_user",
] as const;

export type ReflexSignalName = (typeof REFLEX_SIGNAL_NAMES)[number];
export type ReflexSource = "mirror" | "heartbeat" | "task" | "message" | "other";
export type ReflexObservationStatus =
	| "evaluated"
	| "disabled"
	| "privacy-gated"
	| "protected-zone"
	| "unconfigured"
	| "unsupported-provider"
	| "active-mode-blocked"
	| "error";

export interface ReflexSignals {
	goal_relevance: number;
	novelty: number;
	urgency: number;
	contradiction: number;
	personal_significance: number;
	recall_needed: number;
	wake_system2: number;
	interrupt_user: number;
}

export interface ReflexConfig {
	enabled: boolean;
	shadow: boolean;
	provider: string;
	baseUrl: string;
	model: string;
	apiKeyEnv: string;
	allowExternalState: boolean;
	timeoutMs: number;
}

export interface ReflexCandidate {
	noteId?: string;
	kind: string;
	text?: string;
}

export interface ReflexShadowInput {
	source: ReflexSource;
	sessionId: string;
	currentDecision: string;
	query?: string;
	candidate?: ReflexCandidate;
}

export interface ReflexUsage {
	input_tokens?: number;
	output_tokens?: number;
}

export interface ReflexObservation {
	at: string;
	kind: "reflex-shadow";
	source: ReflexSource;
	sessionId: string;
	currentDecision: string;
	status: ReflexObservationStatus;
	provider: string;
	noteId?: string;
	candidateKind?: string;
	model?: string;
	latencyMs?: number;
	signals?: ReflexSignals;
	usage?: ReflexUsage;
	reason?: string;
	error?: string;
}

export interface ObserveReflexOptions {
	config?: ReflexConfig;
	env?: Record<string, string | undefined>;
	fetcher?: typeof fetch;
	now?: () => string;
}

interface TypeSafeSystemOneResponse {
	model?: unknown;
	answers?: unknown;
	usage?: unknown;
}

const DEFAULT_REFLEX_CONFIG: ReflexConfig = {
	enabled: false,
	shadow: true,
	provider: "typesafe",
	baseUrl: "",
	model: "",
	apiKeyEnv: "TYPESAFE_API_KEY",
	allowExternalState: false,
	timeoutMs: 2500,
};

const QUERY_CHARS = 1200;
const CANDIDATE_CHARS = 1600;
const ERROR_CHARS = 240;
const PROTECTED_NOTE = /^samantha\/(?:wants|journal)(?:\/|$)/;

const REFLEX_QUESTIONS = {
	goal_relevance: {
		type: "noul",
		instructions: "Would this state materially affect one of the user's active goals if such a goal is evidenced in the state?",
	},
	novelty: {
		type: "noul",
		instructions: "Does the candidate add materially new information relative to the current turn rather than merely repeat it?",
	},
	urgency: {
		type: "noul",
		instructions: "Would delaying attention to this state plausibly reduce value or create avoidable risk?",
	},
	contradiction: {
		type: "noul",
		instructions: "Does the candidate materially conflict with the current turn or imply that the current direction may be wrong?",
	},
	personal_significance: {
		type: "noul",
		instructions: "Is the candidate likely personally meaningful beyond simple topical similarity?",
	},
	recall_needed: {
		type: "noul",
		instructions: "Would surfacing this candidate memory plausibly change the next useful response or action?",
	},
	wake_system2: {
		type: "noul",
		instructions: "Does this state warrant slower deliberate reasoning before any consequential action is selected?",
	},
	interrupt_user: {
		type: "noul",
		instructions: "Is this state important and time-sensitive enough that interrupting the user without being asked could be justified?",
	},
} as const;

export async function loadReflexConfig(paths: StorePaths): Promise<ReflexConfig> {
	return parseReflexConfig((await readText(paths.configFile)) ?? "");
}

export function parseReflexConfig(text: string): ReflexConfig {
	const config: ReflexConfig = { ...DEFAULT_REFLEX_CONFIG };
	let inReflex = false;

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "");
		if (!line.trim()) continue;

		const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (top && !/^\s/.test(line)) {
			inReflex = top[1] === "reflex";
			continue;
		}
		if (!inReflex) continue;

		const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!nested) continue;
		const key = nested[1];
		const rawValue = unquote(nested[2].trim());
		switch (key) {
			case "enabled":
				config.enabled = parseBoolean(rawValue, config.enabled);
				break;
			case "shadow":
				config.shadow = parseBoolean(rawValue, config.shadow);
				break;
			case "provider":
				config.provider = rawValue;
				break;
			case "base_url":
				config.baseUrl = rawValue;
				break;
			case "model":
				config.model = rawValue;
				break;
			case "api_key_env":
				config.apiKeyEnv = rawValue;
				break;
			case "allow_external_state":
				config.allowExternalState = parseBoolean(rawValue, config.allowExternalState);
				break;
			case "timeout_ms": {
				const parsed = Number(rawValue);
				if (Number.isFinite(parsed) && parsed > 0) config.timeoutMs = Math.floor(parsed);
				break;
			}
		}
	}

	return config;
}

export async function observeReflexShadow(
	paths: StorePaths,
	input: ReflexShadowInput,
	options: ObserveReflexOptions = {},
): Promise<ReflexObservation> {
	const config = options.config ?? (await loadReflexConfig(paths));
	const now = options.now ?? (() => new Date().toISOString());
	const base: ReflexObservation = {
		at: now(),
		kind: "reflex-shadow",
		source: input.source,
		sessionId: input.sessionId,
		currentDecision: input.currentDecision,
		status: "disabled",
		provider: config.provider || "unconfigured",
		...(input.candidate?.kind ? { candidateKind: input.candidate.kind } : {}),
		...(input.candidate?.noteId && !PROTECTED_NOTE.test(input.candidate.noteId)
			? { noteId: input.candidate.noteId }
			: {}),
	};

	if (!config.enabled) return base;
	if (!config.shadow) return logObservation(paths, { ...base, status: "active-mode-blocked", reason: "v0-shadow-only" });
	if (input.candidate?.noteId && PROTECTED_NOTE.test(input.candidate.noteId)) {
		return logObservation(paths, { ...base, status: "protected-zone", reason: "protected-memory-never-leaves-local-store" });
	}
	if (!config.allowExternalState) {
		return logObservation(paths, { ...base, status: "privacy-gated", reason: "allow_external_state=false" });
	}
	if (config.provider !== "typesafe") {
		return logObservation(paths, { ...base, status: "unsupported-provider", reason: config.provider || "missing-provider" });
	}
	if (!config.baseUrl || !config.model || !config.apiKeyEnv) {
		return logObservation(paths, { ...base, status: "unconfigured", reason: "reflex-base-url-model-or-api-key-env-missing" });
	}

	const env = options.env ?? process.env;
	const apiKey = env[config.apiKeyEnv];
	if (!apiKey) {
		return logObservation(paths, { ...base, status: "unconfigured", reason: "reflex-api-key-missing" });
	}

	const started = Date.now();
	try {
		const result = await evaluateTypeSafeReflex(config, input, apiKey, options.fetcher ?? globalThis.fetch);
		return logObservation(paths, {
			...base,
			status: "evaluated",
			model: result.model,
			latencyMs: Date.now() - started,
			signals: result.signals,
			...(result.usage ? { usage: result.usage } : {}),
		});
	} catch (error) {
		return logObservation(paths, {
			...base,
			status: "error",
			latencyMs: Date.now() - started,
			error: clip(redactSecrets(errorMessage(error)), ERROR_CHARS),
		});
	}
}

async function evaluateTypeSafeReflex(
	config: ReflexConfig,
	input: ReflexShadowInput,
	apiKey: string,
	fetcher: typeof fetch,
): Promise<{ model: string; signals: ReflexSignals; usage?: ReflexUsage }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetcher(systemOneUrl(config.baseUrl), {
			method: "POST",
			headers: {
				accept: "application/json",
				authorization: "Bearer " + apiKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				state: externalState(input),
				questions: REFLEX_QUESTIONS,
				model: config.model,
			}),
			signal: controller.signal,
		});
		if (!response.ok) throw new Error("TypeSafe System One request failed: HTTP " + response.status);
		const payload = (await response.json()) as TypeSafeSystemOneResponse;
		return parseTypeSafeResponse(payload, config.model);
	} finally {
		clearTimeout(timer);
	}
}

function externalState(input: ReflexShadowInput): Record<string, unknown> {
	const query = clip(redactSecrets(input.query ?? ""), QUERY_CHARS);
	const candidate = clip(redactSecrets(input.candidate?.text ?? ""), CANDIDATE_CHARS);
	return {
		source: input.source,
		current_decision: input.currentDecision,
		has_query: Boolean(query),
		...(query ? { query } : {}),
		...(input.candidate
			? {
					candidate: {
						kind: input.candidate.kind,
						has_text: Boolean(candidate),
						...(candidate ? { text: candidate } : {}),
					},
				}
			: {}),
	};
}

function parseTypeSafeResponse(
	payload: TypeSafeSystemOneResponse,
	fallbackModel: string,
): { model: string; signals: ReflexSignals; usage?: ReflexUsage } {
	if (!isRecord(payload.answers)) throw new Error("TypeSafe System One response missing answers");
	const answers = payload.answers;
	const signals: ReflexSignals = {
		goal_relevance: readNoul(answers, "goal_relevance"),
		novelty: readNoul(answers, "novelty"),
		urgency: readNoul(answers, "urgency"),
		contradiction: readNoul(answers, "contradiction"),
		personal_significance: readNoul(answers, "personal_significance"),
		recall_needed: readNoul(answers, "recall_needed"),
		wake_system2: readNoul(answers, "wake_system2"),
		interrupt_user: readNoul(answers, "interrupt_user"),
	};
	const usage = parseUsage(payload.usage);
	return {
		model: typeof payload.model === "string" && payload.model.trim() ? payload.model : fallbackModel,
		signals,
		...(usage ? { usage } : {}),
	};
}

function readNoul(answers: Record<string, unknown>, name: ReflexSignalName): number {
	const answer = answers[name];
	if (!isRecord(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
		throw new Error("TypeSafe System One response missing noul answer: " + name);
	}
	if (answer.noul < 0 || answer.noul > 1) throw new Error("TypeSafe System One answer out of range: " + name);
	return answer.noul;
}

function parseUsage(value: unknown): ReflexUsage | undefined {
	if (!isRecord(value)) return undefined;
	const usage: ReflexUsage = {};
	if (typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens)) usage.input_tokens = value.input_tokens;
	if (typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens)) {
		usage.output_tokens = value.output_tokens;
	}
	return Object.keys(usage).length > 0 ? usage : undefined;
}

async function logObservation(paths: StorePaths, observation: ReflexObservation): Promise<ReflexObservation> {
	try {
		await appendText(join(paths.herDir, "reflex-log.jsonl"), JSON.stringify(observation) + "\n");
	} catch (error) {
		console.warn("[her] reflex shadow log skipped: " + errorMessage(error));
	}
	return observation;
}

function systemOneUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "") + "/v1/systemone";
}

function parseBoolean(value: string, fallback: boolean): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function unquote(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function clip(text: string, maxChars: number): string {
	const trimmed = text.trim();
	return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object");
}
