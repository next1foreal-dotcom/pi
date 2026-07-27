/**
 * G-146 — deer-workflow Agent backed by Samantha/pi headless (`--print --mode json`).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AgentOptions, JsonSchema } from "./deer-agent-types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/her/src/her-core → samantha repo root */
const SAMANTHA_REPO_ROOT = resolve(HERE, "../../../..");

export type SamanthaAgentSpawnResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type SamanthaAgentSpawnFn = (opts: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}) => Promise<SamanthaAgentSpawnResult>;

export type SamanthaAgentConfig = {
	/** Absolute path to pi/coding-agent cli.js. */
	cliPath?: string;
	provider?: string;
	model?: string;
	spawnFn?: SamanthaAgentSpawnFn;
	defaultCwd?: string;
	env?: NodeJS.ProcessEnv;
};

function resolvePiCliPath(env: NodeJS.ProcessEnv, override?: string): string {
	if (override?.trim()) return resolve(override.trim());
	const fromEnv = env.HER_DEER_PI_CLI?.trim() || env.HER_DISPATCH_PI_CLI?.trim();
	if (fromEnv) return resolve(fromEnv);
	return join(SAMANTHA_REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
}

function extractTextFromPiPrint(stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";
	// Prefer last JSON object line with a text-ish field (pi --mode json NDJSON).
	const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
			if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
			if (typeof obj.message === "string" && obj.message.trim()) return obj.message;
			if (typeof obj.content === "string" && obj.content.trim()) return obj.content;
			if (obj.type === "message" && typeof obj.content === "string") return obj.content;
		} catch {
			/* keep scanning */
		}
	}
	return trimmed;
}

function parseSchemaOutput<TOutput>(text: string, schema: JsonSchema | undefined): TOutput {
	if (!schema) return text as TOutput;
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	const slice = start >= 0 && end > start ? text.slice(start, end + 1) : text;
	try {
		return JSON.parse(slice) as TOutput;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`SamanthaAgent: failed to parse schema JSON: ${detail}\n---\n${text}`);
	}
}

const defaultSpawn: SamanthaAgentSpawnFn = ({ command, args, cwd, env, signal }) =>
	new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (c: string) => {
			stdout += c;
		});
		child.stderr?.on("data", (c: string) => {
			stderr += c;
		});
		const onAbort = () => {
			child.kill();
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", reject);
		child.on("close", (code) => {
			if (signal) signal.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
		});
	});

export class SamanthaAgent implements Agent {
	readonly #cliPath: string;
	readonly #provider: string;
	readonly #model: string;
	readonly #spawnFn: SamanthaAgentSpawnFn;
	readonly #defaultCwd: string;
	readonly #env: NodeJS.ProcessEnv;

	constructor(config: SamanthaAgentConfig = {}) {
		const env = config.env ?? process.env;
		this.#cliPath = resolvePiCliPath(env, config.cliPath);
		this.#provider = config.provider?.trim() || env.HER_DEER_PI_PROVIDER?.trim() || "deepseek";
		this.#model = config.model?.trim() || env.HER_DEER_PI_MODEL?.trim() || "deepseek-v4-flash";
		this.#spawnFn = config.spawnFn ?? defaultSpawn;
		this.#defaultCwd = config.defaultCwd?.trim() || process.cwd();
		this.#env = env;
	}

	async run<TOutput = string>(prompt: string, options?: AgentOptions): Promise<TOutput> {
		if (options?.signal?.aborted) {
			throw new Error("SamanthaAgent: aborted before start");
		}
		if (!existsSync(this.#cliPath)) {
			throw new Error(
				`SamanthaAgent: pi CLI not found at ${this.#cliPath} (build packages/coding-agent or set HER_DEER_PI_CLI)`,
			);
		}

		const cwd = options?.cwd?.trim() || this.#defaultCwd;
		const provider = options?.model?.includes("/") ? options.model.split("/")[0]! : this.#provider;
		const model = options?.model?.includes("/")
			? options.model.split("/").slice(1).join("/")
			: options?.model?.trim() || this.#model;

		let fullPrompt = prompt;
		if (options?.schema) {
			fullPrompt = `${prompt}\n\nRespond with JSON only matching this JSON Schema:\n${JSON.stringify(options.schema)}`;
		}
		if (options?.sandbox === "read-only") {
			fullPrompt = `[sandbox: read-only — do not modify files]\n\n${fullPrompt}`;
		}

		const args = [this.#cliPath, "--print", "--mode", "json", "--provider", provider, "--model", model, fullPrompt];

		const childEnv: NodeJS.ProcessEnv = { ...this.#env, ...(options?.env ?? {}) };
		const result = await this.#spawnFn({
			command: process.execPath,
			args,
			cwd,
			env: childEnv,
			signal: options?.signal,
		});

		if (result.exitCode !== 0) {
			throw new Error(`SamanthaAgent: pi exited ${result.exitCode}\n${result.stderr || result.stdout}`.trim());
		}

		const text = extractTextFromPiPrint(result.stdout);
		return parseSchemaOutput<TOutput>(text, options?.schema);
	}
}

/** Deterministic stub for CI / HER_DEER_AGENT=fake. */
export class FakeDeerAgent implements Agent {
	async run<TOutput = string>(prompt: string, options?: AgentOptions): Promise<TOutput> {
		const schema = options?.schema;
		if (schema && schema.type === "array") {
			return ["Independent angle A", "Independent angle B"] as TOutput;
		}
		if (schema && schema.type === "object") {
			return {
				summary: `fake:${prompt.slice(0, 80)}`,
				sources: ["https://example.com/fake"],
				ok: true,
			} as TOutput;
		}
		return `fake-agent: ${prompt.slice(0, 200)}` as TOutput;
	}
}

export function createDeerAgentFromEnv(env: NodeJS.ProcessEnv = process.env): Agent {
	const kind = (env.HER_DEER_AGENT ?? "samantha").trim().toLowerCase();
	switch (kind) {
		case "fake":
			return new FakeDeerAgent();
		case "samantha":
		case "pi":
			return new SamanthaAgent({ env });
		default:
			throw new Error(`createDeerAgentFromEnv: unknown HER_DEER_AGENT="${kind}" (use samantha|fake)`);
	}
}
