import { join } from "node:path";

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
] as const;

export type WorkerProfile = {
	argv: string[];
	envAllow?: string[];
};

type RawProfile = { argv?: unknown; envAllow?: unknown };

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
		const value = parseArrayValue(fieldMatch[2].trim());
		if (fieldMatch[1] === "argv") current.argv = value;
		else if (fieldMatch[1] === "env_allow") current.envAllow = value;
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
	};
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

/** Add Codex's machine-readable event stream and final-result file without mutating user config. */
export function prepareWorkerCommand(
	workerName: string,
	profile: WorkerProfile,
	taskDir: string,
	taskId: string,
): string[] {
	const command = [...profile.argv];
	if (workerName.toLowerCase() !== "codex") return command;
	if (!command.includes("--json")) command.push("--json");
	if (!command.includes("-o") && !command.includes("--output-last-message")) {
		command.push("-o", join(taskDir, `${taskId}.result.md`));
	}
	return command;
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
	if (ownerSessionId) env.HER_TASK_OWNER_SESSION_ID = ownerSessionId;
	return env;
}
