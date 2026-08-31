import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * G-129 — worker profiles (config `workers:` section): argv + env allowlist per named CLI.
 * `workers:` missing entirely is not an error (see bg-task-config.ts WARN+default semantics);
 * a present-but-malformed worker entry is fail-loud (D3).
 */

const BASE_ENV_ALLOW = [
	"SystemRoot",
	"ComSpec",
	"PATH",
	"PATHEXT",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"HOME",
	"TEMP",
	"TMP",
	// G-223R — reach the public internet. Without these a worker on a machine that
	// needs a proxy dials out direct and gets region-blocked: the claude-tier worker
	// died with `403 Request not allowed` while the same command succeeded in a shell
	// that had them (controlled probe, 2026-08-05). Both spellings: CLIs disagree on case.
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"all_proxy",
	"no_proxy",
	// Node's fetch ignores the proxy vars above unless this is set (blood lesson).
	"NODE_USE_ENV_PROXY",
] as const;

export type WorkerProfile = {
	argv: string[];
	/** Built-in profile identity and execution root; config profiles omit both fields. */
	name?: string;
	cwd?: string;
	envAllow?: string[];
	/**
	 * G-197 — what one run of this worker actually costs, in USD. Absent means
	 * free: `codex exec` and `claude -p` bill against a subscription and `deer`
	 * runs on this machine, so a task through them moves no money. Only a worker
	 * that really meters per token declares a price.
	 */
	priceUsd?: number;
};

type RawProfile = { argv?: unknown; envAllow?: unknown; priceUsd?: unknown };

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMANTHA_REPO_ROOT = resolve(HERE, "../../../..");
export const PANEL_CHAIR_WORKER_NAME = "panel-chair";
// 2026-08-04 probe: the machine-level stale key forced member requests to 401.
export const STALE_ENV_KEYS = ["DEEPSEEK_API_KEY"] as const;

/** Resolve the headless Samantha CLI using the deer/dispatch environment precedence. */
export function resolvePanelChairCliPath(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.HER_DEER_PI_CLI?.trim() || env.HER_DISPATCH_PI_CLI?.trim();
	return fromEnv ? resolve(fromEnv) : join(SAMANTHA_REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
}

/** Built-in PANEL-CHAIR profile; callers receive a fresh argv so env overrides are read at dispatch time. */
export function createPanelChairWorkerProfile(env: NodeJS.ProcessEnv = process.env): WorkerProfile {
	return {
		name: PANEL_CHAIR_WORKER_NAME,
		argv: [process.execPath, resolvePanelChairCliPath(env), "-p", "--mode", "json", "--no-session"],
		cwd: SAMANTHA_REPO_ROOT,
		// This is deliberately listed then removed by buildWorkerEnv: the stale machine key must never cross this boundary.
		envAllow: ["DEEPSEEK_API_KEY"],
	};
}

export const BUILTIN_WORKER_PROFILES: Record<string, WorkerProfile> = {
	[PANEL_CHAIR_WORKER_NAME]: createPanelChairWorkerProfile(),
};

export function getBuiltinWorkerProfiles(env: NodeJS.ProcessEnv = process.env): Record<string, WorkerProfile> {
	return { [PANEL_CHAIR_WORKER_NAME]: createPanelChairWorkerProfile(env) };
}

/** Parse the top-level `workers:` block out of a full config.yaml text. Malformed entries throw. */
export function parseWorkers(text: string): Record<string, WorkerProfile> {
	const workers: Record<string, WorkerProfile> = {};
	let inWorkers = false;
	let currentName: string | undefined;
	let current: RawProfile | undefined;

	const flush = () => {
		if (!currentName || !current) return;
		workers[currentName] = validateProfile(currentName, current);
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "");
		if (!line.trim()) continue;

		if (!/^[ \t]/.test(line)) {
			flush();
			currentName = undefined;
			current = undefined;
			inWorkers = /^workers:\s*$/.test(line);
			continue;
		}
		if (!inWorkers) continue;

		const nameMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (nameMatch) {
			flush();
			currentName = nameMatch[1];
			current = {};
			continue;
		}
		const fieldMatch = /^ {4,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!fieldMatch || !current) continue;
		const raw = fieldMatch[2].trim();
		if (fieldMatch[1] === "argv") current.argv = parseArrayValue(raw);
		else if (fieldMatch[1] === "env_allow") current.envAllow = parseArrayValue(raw);
		else if (fieldMatch[1] === "price_usd") current.priceUsd = raw;
	}
	flush();
	return workers;
}

function parseArrayValue(raw: string): string[] {
	if (!(raw.startsWith("[") && raw.endsWith("]"))) return [];
	const inner = raw.slice(1, -1).trim();
	if (!inner) return [];
	return inner
		.split(",")
		.map((s) => s.trim().replace(/^["']|["']$/g, ""))
		.filter((s) => s.length > 0);
}

function validateProfile(name: string, raw: RawProfile): WorkerProfile {
	if (
		!Array.isArray(raw.argv) ||
		raw.argv.length === 0 ||
		!raw.argv.every((x) => typeof x === "string" && x.length > 0)
	) {
		throw new Error(`workers.${name}.argv must be a non-empty array of non-empty strings`);
	}
	if (
		raw.envAllow !== undefined &&
		(!Array.isArray(raw.envAllow) || !raw.envAllow.every((x) => typeof x === "string"))
	) {
		throw new Error(`workers.${name}.env_allow must be an array of strings`);
	}
	return {
		argv: [...raw.argv],
		...(raw.envAllow ? { envAllow: [...raw.envAllow] } : {}),
		...(raw.priceUsd !== undefined ? { priceUsd: parsePrice(name, raw.priceUsd) } : {}),
	};
}

/** A declared price must be a real non-negative number — a typo must not read as free. */
function parsePrice(name: string, raw: unknown): number {
	const text = String(raw)
		.trim()
		.replace(/^["']|["']$/g, "");
	const value = text === "" ? Number.NaN : Number(text);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`workers.${name}.price_usd must be a non-negative number (got "${text}")`);
	}
	return value;
}

/** Unknown name → throw, listing the configured profile keys. */
export function resolveWorkerInvocation(workers: Record<string, WorkerProfile>, name: string): WorkerProfile {
	const profile = workers[name];
	if (!profile) {
		const keys = Object.keys(workers);
		const available = keys.length > 0 ? keys.join(", ") : "(none configured)";
		throw new Error(`unknown worker profile "${name}" — available: ${available}`);
	}
	return profile;
}

/** G-225 — resolve the model declared by a worker profile, never the profile name itself. */
export function resolveWorkerModel(argv: readonly string[]): string | "unknown" {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-m" || arg === "--model") {
			const value = argv[index + 1];
			return value && !value.startsWith("-") ? value : "unknown";
		}
		if (arg.startsWith("--model=")) {
			const value = arg.slice("--model=".length);
			return value || "unknown";
		}
	}
	return "unknown";
}

/**
 * Add Codex's machine-readable event stream and final-result file without mutating user config.
 *
 * G-187 — the flags are **inserted after `exec`, not appended**. `codex exec [OPTIONS] [PROMPT]`
 * tolerates trailing options, but `codex exec resume <SESSION_ID> <PROMPT>` does not: a flag after
 * its positionals makes codex print usage and exit non-zero (verified, codex-cli 0.145.0). One
 * placement rule that is legal for both shapes beats two rules.
 *
 * `--skip-git-repo-check` goes in for the same reason it was invisible before: a worker's cwd is
 * `<memoryRoot>/.her/tasks` (the task-artifact directory, not a workspace), so codex's "trusted
 * directory" gate passed only by accident — because her-memory happens to be a git repo. Saying it
 * out loud keeps a non-git memory root from failing continues with an unrelated-looking error.
 *
 * G-354 — grok does not read stdin (`grok -p -` sends the literal "-"). The pipeline already
 * writes `<taskDir>/<taskId>.brief` before launch (G-129 sentinel; retries and retention know
 * that name). This branch injects `--prompt-file` pointing at that file. It does **not** invent
 * a `.brief.md` sibling — `isTaskRecordFile` would ignore it, but retention's SENTINELS list
 * `brief`, not `brief.md`, and two files would drift.
 *
 * Placement: after argv[0] when the binary is grok (options before any positional prompt);
 * otherwise appended, so a node wrapper used in tests is not given unknown node flags.
 *
 * Idempotent: a flag the caller already configured is never added twice.
 */
export function prepareWorkerCommand(
	workerName: string,
	profile: WorkerProfile,
	taskDir: string,
	taskId: string,
): string[] {
	const command = [...profile.argv];
	if (workerName.toLowerCase() === "codex") {
		const flags: string[] = [];
		if (!command.includes("--json")) flags.push("--json");
		if (!command.includes("-o") && !command.includes("--output-last-message")) {
			flags.push("-o", join(taskDir, `${taskId}.result.md`));
		}
		if (!command.includes("--skip-git-repo-check")) flags.push("--skip-git-repo-check");
		if (flags.length === 0) return command;
		// Options belong before any subcommand/positional; fall back to appending for an argv shape
		// we do not recognise.
		const at = command[1] === "exec" ? 2 : command.length;
		return [...command.slice(0, at), ...flags, ...command.slice(at)];
	}
	if (isGrokInvocation(workerName, command)) return injectGrokPromptFile(command, taskDir, taskId);
	return command;
}

/** Strip Windows shim suffixes so `grok.exe` / `grok.cmd` still identify as grok. */
export function workerCliName(file: string | undefined): string {
	return basename(file ?? "")
		.toLowerCase()
		.replace(/\.(exe|cmd|bat)$/i, "");
}

/**
 * G-354 — fire on the worker name `grok`, the recommended archive name `grok_build`,
 * or an argv whose binary is grok (bare-command fallback keys off argv[0] the same way).
 */
export function isGrokInvocation(workerName: string, argv: readonly string[]): boolean {
	const name = workerName.toLowerCase();
	if (name === "grok" || name === "grok_build") return true;
	return workerCliName(argv[0]) === "grok";
}

/** `-p` and `--single` are the same grok flag (single-turn prompt); do not also inject --prompt-file. */
function hasGrokPrompt(command: readonly string[]): boolean {
	for (const arg of command) {
		if (arg === "--prompt-file" || arg === "-p" || arg === "--single") return true;
		if (arg.startsWith("--prompt-file=") || arg.startsWith("--single=")) return true;
	}
	return false;
}

function injectGrokPromptFile(command: string[], taskDir: string, taskId: string): string[] {
	if (hasGrokPrompt(command)) return command;
	const flags = ["--prompt-file", join(taskDir, `${taskId}.brief`)];
	if (workerCliName(command[0]) === "grok") {
		return [command[0], ...flags, ...command.slice(1)];
	}
	return [...command, ...flags];
}

/**
 * G-187 — build `codex exec [OPTIONS] resume <SESSION_ID> <PROMPT>` from a worker profile.
 *
 * A continuation must run with the parent's posture, not codex's defaults. Measured on a real
 * resume before this existed: the parent ran `gpt-5.6-terra / effort=medium / sandbox=workspace-write`
 * while its continuation silently landed on `gpt-5.6-luna / effort=max / sandbox=read-only` — a
 * pricier model that also could not write. "Looks like it is continuing, actually swapped the
 * brain" is the failure this prevents.
 *
 * The profile's trailing `-` (read the prompt from stdin) is dropped: a resume carries its prompt
 * as an argument, and stdin is not wired for it.
 */
export function buildCodexResumeCommand(profileArgv: readonly string[], sessionId: string, message: string): string[] {
	const flags = [...profileArgv];
	while (flags.length > 0 && flags[flags.length - 1] === "-") flags.pop();
	// `resume` is a subcommand of `exec`; a profile that omits it would build an invalid command.
	if (!flags.includes("exec")) flags.splice(1, 0, "exec");
	return [...flags, "resume", sessionId, message];
}

/** D9 — minimal env for a worker process: base allowlist + profile.envAllow, never the full parent env. */
export function buildWorkerEnv(profile: WorkerProfile, taskId: string, ownerSessionId?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [...BASE_ENV_ALLOW, ...(profile.envAllow ?? [])]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	env.HER_TASK_ID = taskId;
	// G-185/S5 — ownership travels to the worker over env, not the brief: the brief is
	// model-authored text, env is harness-authored fact. Absent = ownerless, field omitted.
	if (profile.name === PANEL_CHAIR_WORKER_NAME) {
		for (const key of STALE_ENV_KEYS) delete env[key];
	}
	if (ownerSessionId) env.HER_TASK_OWNER_SESSION_ID = ownerSessionId;
	return env;
}
