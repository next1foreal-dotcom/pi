import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadRuntimeConfig } from "../her-core/bg-task-config.ts";
import { canonicalJson, sha256 } from "../her-core/improvement-plan.ts";
import {
	assertCompleteResponse,
	type CompletionDiagnostics,
	type CompletionMeta,
	type CompletionOptions,
	type CompletionResult,
	type ModelLike,
	validateCompletionOptions,
} from "../her-core/model.ts";
import { redactSecrets, writeNewText } from "../her-core/store.ts";
import type { GrowthHostPlan } from "./host.ts";
import { record } from "./parse.ts";

export const GROK_BUILD_PROVIDER = "grok-build-oauth";
export const GROK_BUILD_ENDPOINT = "grok-build://official-cli/subscription";
export interface GrokBuildTransport {
	kind: "grok-build";
	executable: { path: string; sha256: string };
	authPath: string;
	reasoningEffort: "low" | "high";
	usdAccounting: "api-equivalent-estimate";
	reasoningAccounting: "return-time";
}
interface NativeReceipt {
	sessionId: string;
	requestId?: string;
	stopReason: string;
	modelCalls: number;
	providerReportedUsd: number | "unknown";
	uncachedInput: number;
	cachedInput: number;
	cacheCreationInput: number;
	output: number;
	total: number;
	reasoning?: number;
}
interface NativeDiagnostics extends CompletionDiagnostics {
	nativeReceipt?: NativeReceipt;
	identitySource: "native-cli-ledger" | "unreported";
}
export interface NativeExecution {
	stdout: string;
	exitCode: number;
}
export type NativeExecutor = (request: {
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	maxBytes: number;
}) => Promise<NativeExecution>;
const executeNative: NativeExecutor = (request) =>
	new Promise((done) => {
		execFile(
			request.executable,
			request.args,
			{
				cwd: request.cwd,
				env: request.env,
				signal: request.signal,
				timeout: 180000,
				maxBuffer: request.maxBytes,
				encoding: "utf8",
				windowsHide: true,
			},
			(error, stdout) => done({ stdout, exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0 }),
		);
	});
const count = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const label = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);

/** Native JSON only. Never use streaming-messages-json's zero-filled cost/usage fallbacks. */
export function parseGrokBuildReceipt(raw: unknown, sessionId: string, reported: readonly string[]): CompletionResult {
	const data = record(raw, "native CLI result");
	const text = typeof data.text === "string" ? data.text : "";
	const diagnostics: NativeDiagnostics = {
		// This is a process protocol, not an HTTP response; 0 explicitly means no HTTP status observed.
		httpStatus: 0,
		choiceCount: text ? 1 : 0,
		contentBytes: Buffer.byteLength(text),
		reasoningBytes: typeof data.thought === "string" ? Buffer.byteLength(data.thought) : 0,
		modelIdentity: "requested-fallback",
		usageStatus: "missing",
		identitySource: "unreported",
	};
	const result: CompletionResult = { text, provider: GROK_BUILD_PROVIDER, diagnostics };
	const finish = data.stopReason;
	if (label(finish))
		result.finishReason =
			finish === "end_turn" ? "stop" : finish === "max_tokens" || finish === "max_turn_requests" ? "length" : finish;
	if (data.type === "error" && data.sessionId === undefined) return result;
	if (data.sessionId !== sessionId) throw new Error("native result belongs to another session");
	if (!data.usage || typeof data.usage !== "object" || Array.isArray(data.usage)) return result;
	const usage = record(data.usage, "native usage");
	const keys = [
		"input_tokens",
		"cache_read_input_tokens",
		"cache_creation_input_tokens",
		"output_tokens",
		"total_tokens",
	] as const;
	if (keys.some((key) => !count(usage[key])) || data.usage_is_incomplete === true) {
		diagnostics.usageStatus = "invalid";
		return result;
	}
	const input =
		Number(usage.input_tokens) + Number(usage.cache_read_input_tokens) + Number(usage.cache_creation_input_tokens);
	const output = Number(usage.output_tokens);
	if (
		!count(input) ||
		!count(input + output) ||
		input + output !== usage.total_tokens ||
		(usage.reasoning_tokens !== undefined && (!count(usage.reasoning_tokens) || usage.reasoning_tokens > output))
	) {
		diagnostics.usageStatus = "invalid";
		return result;
	}
	const models =
		data.modelUsage && typeof data.modelUsage === "object" && !Array.isArray(data.modelUsage)
			? record(data.modelUsage, "model ledger")
			: {};
	const names = Object.keys(models);
	if (names.length !== 1 || !reported.includes(names[0])) {
		diagnostics.usageStatus = "invalid";
		return result;
	}
	const model = record(models[names[0]], "model usage");
	if (
		data.num_turns !== 1 ||
		model.modelCalls !== 1 ||
		model.inputTokens !== usage.input_tokens ||
		model.outputTokens !== output ||
		model.cacheReadInputTokens !== usage.cache_read_input_tokens
	) {
		diagnostics.usageStatus = "invalid";
		return result;
	}
	const usd =
		typeof data.total_cost_usd === "number" &&
		Number.isFinite(data.total_cost_usd) &&
		data.total_cost_usd >= 0 &&
		data.cost_is_partial !== true
			? data.total_cost_usd
			: "unknown";
	diagnostics.nativeReceipt = {
		sessionId,
		...(label(data.requestId) ? { requestId: data.requestId } : {}),
		stopReason: label(finish) ? finish : "unknown",
		modelCalls: 1,
		providerReportedUsd: usd,
		uncachedInput: Number(usage.input_tokens),
		cachedInput: Number(usage.cache_read_input_tokens),
		cacheCreationInput: Number(usage.cache_creation_input_tokens),
		output,
		total: Number(usage.total_tokens),
		...(count(usage.reasoning_tokens) ? { reasoning: usage.reasoning_tokens } : {}),
	};
	diagnostics.modelIdentity = "reported";
	diagnostics.identitySource = "native-cli-ledger";
	diagnostics.usageStatus = "complete";
	result.model = names[0];
	result.usage = { prompt_tokens: input, completion_tokens: output, total_tokens: Number(usage.total_tokens) };
	return result;
}
export function grokBuildSpend(result: CompletionResult) {
	const receipt = (result.diagnostics as NativeDiagnostics | undefined)?.nativeReceipt;
	return receipt
		? {
				costBasis: "api-equivalent-estimate",
				providerReportedUsd: receipt.providerReportedUsd,
				nativeReceipt: receipt,
			}
		: {};
}
export function growthModelEndpoint(root: string, plan: Readonly<GrowthHostPlan>): string {
	return plan.model.grokBuild ? GROK_BUILD_ENDPOINT : loadRuntimeConfig(root).llm.baseUrl;
}
export function validateGrokBuildPolicy(plan: Readonly<GrowthHostPlan>): void {
	const transport = plan.model.grokBuild;
	if (
		!transport ||
		transport.kind !== "grok-build" ||
		transport.usdAccounting !== "api-equivalent-estimate" ||
		transport.reasoningAccounting !== "return-time" ||
		!["low", "high"].includes(transport.reasoningEffort) ||
		!isAbsolute(transport.executable?.path ?? "") ||
		!/^[a-f0-9]{64}$/.test(transport.executable?.sha256 ?? "") ||
		!isAbsolute(transport.authPath ?? "") ||
		plan.model.request !== "grok-4.5" ||
		plan.model.inputUsdPerMillion < 2 ||
		plan.model.outputUsdPerMillion < 6 ||
		plan.model.provider !== GROK_BUILD_PROVIDER ||
		!plan.model.reported.includes(plan.model.request) ||
		plan.model.maxOutputTokens > 8192 ||
		plan.model.requestOptions?.requireComplete !== true ||
		plan.model.requestOptions.thinking !== undefined ||
		plan.model.requestOptions.responseFormat !== undefined ||
		(plan.model.requestOptions.reasoningEffort !== undefined &&
			plan.model.requestOptions.reasoningEffort !== transport.reasoningEffort) ||
		!Number.isSafeInteger(plan.budget.requests) ||
		!plan.pilot
	)
		throw new Error("explicit frozen native subscription policy and owner pilot required");
}
/** Per-inquiry port only. No global model/config/key changes; all growth/STOP/budget checks stay in GrowthHost. */
export class GrokBuildModel implements ModelLike {
	lastCompletion?: CompletionMeta;
	readonly root: string;
	readonly bindingDigest: string;
	private readonly plan: Readonly<GrowthHostPlan>;
	private readonly env: NodeJS.ProcessEnv;
	private readonly executor: NativeExecutor;
	constructor(
		root: string,
		plan: Readonly<GrowthHostPlan>,
		env: NodeJS.ProcessEnv = process.env,
		executor: NativeExecutor = executeNative,
	) {
		validateGrokBuildPolicy(plan);
		this.root = resolve(root);
		this.plan = JSON.parse(JSON.stringify(plan)) as GrowthHostPlan;
		this.bindingDigest = sha256(
			canonicalJson({ inquiryId: plan.inquiryId, model: plan.model, outputBytes: plan.budget.outputBytes }),
		);
		this.env = env;
		this.executor = executor;
	}
	async verifyBinding(plan: Readonly<GrowthHostPlan>, root: string): Promise<void> {
		validateGrokBuildPolicy(plan);
		if (
			resolve(root) !== this.root ||
			this.bindingDigest !==
				sha256(
					canonicalJson({ inquiryId: plan.inquiryId, model: plan.model, outputBytes: plan.budget.outputBytes }),
				)
		)
			throw new Error("native model port is not bound to this frozen inquiry");
		const digest = createHash("sha256");
		for await (const part of createReadStream(this.plan.model.grokBuild!.executable.path)) digest.update(part);
		if (digest.digest("hex") !== this.plan.model.grokBuild!.executable.sha256)
			throw new Error("approved native executable changed");
	}
	async complete(prompt: string, options: CompletionOptions = {}): Promise<string> {
		return (await this.completeWithMeta(prompt, options)).text;
	}
	async completeWithMeta(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
		this.lastCompletion = undefined;
		validateCompletionOptions(options);
		if (
			options.singleRequest !== true ||
			options.requireComplete !== true ||
			options.maxTokens !== this.plan.model.maxOutputTokens ||
			options.thinking !== undefined ||
			options.responseFormat !== undefined ||
			(options.reasoningEffort !== undefined &&
				options.reasoningEffort !== this.plan.model.grokBuild!.reasoningEffort)
		)
			throw new Error("native request must use frozen single-request final-response policy");
		options.signal?.throwIfAborted();
		await this.verifyBinding(this.plan, this.root);
		if (!/^[A-Za-z0-9_-]{1,100}$/.test(this.plan.inquiryId)) throw new Error("unsafe native inquiry id");
		const sessionId = randomUUID();
		const base = join(this.root, ".her");
		await mkdir(base, { recursive: true });
		if ((await lstat(base)).isSymbolicLink()) throw new Error("native runtime parent is a link");
		const runtimeBase = join(base, `growth-native-${this.plan.inquiryId}`);
		await mkdir(runtimeBase, { recursive: true });
		if ((await lstat(runtimeBase)).isSymbolicLink()) throw new Error("native runtime base is a link");
		const runtime = join(runtimeBase, sessionId);
		await mkdir(runtime);
		const grokHome = join(runtime, "grok-home");
		await mkdir(grokHome);
		const policy = this.plan.model.grokBuild!;
		const settings = {
			max_completion_tokens: options.maxTokens,
			max_retries: 0,
			rate_limit_retry_threshold: 1,
			subagent_rate_limit_max_attempts: 0,
		};
		const config = {
			cli: { auto_update: false },
			auth: { disable_api_key_auth: true },
			models: { default: this.plan.model.request, allowed_models: [this.plan.model.request], ...settings },
			model: { [this.plan.model.request]: settings },
			doom_loop_recovery: { enabled: false },
			features: { telemetry: false, feedback: false, codebase_indexing: false, title_refresh: false },
			telemetry: { mixpanel_enabled: false, trace_upload: false },
			session: { load_envrc: false },
			workflows: { enabled: false },
			prompt_suggestions: { enabled: false },
			dashboard: { enabled: false },
			compat: {
				cursor: { skills: false, rules: false, agents: false, mcps: false, hooks: false, sessions: false },
				claude: { skills: false, rules: false, agents: false, mcps: false, hooks: false, sessions: false },
				codex: { sessions: false },
			},
			marketplace: { default_skills_installs_purged: true, official_marketplace_auto_installed: true },
		};
		const configPath = join(runtime, "config.json");
		await writeNewText(configPath, JSON.stringify(config));
		await writeNewText(join(runtime, "prompt.txt"), prompt);
		const env: NodeJS.ProcessEnv = {};
		for (const name of [
			"SystemRoot",
			"SYSTEMROOT",
			"WINDIR",
			"PATH",
			"Path",
			"PATHEXT",
			"TEMP",
			"TMP",
			"USERPROFILE",
			"APPDATA",
			"LOCALAPPDATA",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"NO_PROXY",
			"http_proxy",
			"https_proxy",
			"all_proxy",
			"no_proxy",
		])
			if (this.env[name] !== undefined) env[name] = this.env[name];
		Object.assign(env, {
			HOME: runtime,
			GROK_HOME: grokHome,
			GROK_CONFIG_PATH: configPath,
			GROK_AUTH_PATH: policy.authPath,
			GROK_MEMORY: "0",
			GROK_MAX_RETRIES: "0",
		});
		const args = [
			"--cwd",
			runtime,
			"--leader-socket",
			join(runtimeBase, "leader.sock"),
			"--prompt-file",
			join(runtime, "prompt.txt"),
			"--model",
			this.plan.model.request,
			"--session-id",
			sessionId,
			"--output-format",
			"json",
			"--tools",
			"",
			"--disallowed-tools",
			"Agent",
			"--deny",
			"MCPTool",
			"--disable-web-search",
			"--no-plan",
			"--no-subagents",
			"--max-turns",
			"1",
			"--verbatim",
			"--reasoning-effort",
			policy.reasoningEffort,
		];
		options.signal?.throwIfAborted();
		const executed = await this.executor({
			executable: policy.executable.path,
			args,
			cwd: runtime,
			env,
			signal: options.signal,
			maxBytes: this.plan.budget.outputBytes,
		});
		let raw: unknown;
		try {
			raw = JSON.parse(executed.stdout);
		} catch {
			throw new Error(
				`native CLI returned invalid JSON: exit=${executed.exitCode}; usage unknown; no automatic retry`,
			);
		}
		const result = parseGrokBuildReceipt(raw, sessionId, this.plan.model.reported);
		this.lastCompletion = result;
		await writeNewText(join(runtime, "response.txt"), result.text);
		const native = record(raw, "native result");
		if (executed.exitCode !== 0 || native.type === "error") {
			const detail =
				typeof native.message === "string"
					? redactSecrets(native.message).slice(0, 1000)
					: "no reported error message";
			throw new Error(`native CLI failed: exit=${executed.exitCode}; ${detail}; no automatic retry`);
		}
		assertCompleteResponse(result);
		if (result.diagnostics?.usageStatus !== "complete") throw new Error("complete native model usage required");
		return result;
	}
}
