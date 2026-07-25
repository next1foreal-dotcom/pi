import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execCapabilities, isExecBackend } from "./capabilities.ts";
import type { ExecBackend, ExecResolution } from "./types.ts";

export interface ResolveExecOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}

function readProjectExecBackend(cwd: string): ExecBackend | undefined {
	const path = join(cwd, ".pi", "exec.json");
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { backend?: unknown };
		if (typeof parsed.backend === "string" && isExecBackend(parsed.backend)) return parsed.backend;
	} catch {
		return undefined;
	}
	return undefined;
}

function defaultBackend(platform: NodeJS.Platform): ExecBackend {
	if (platform === "linux" || platform === "darwin") return "native";
	return "native";
}

export function resolveExec(opts: ResolveExecOptions = {}): ExecResolution {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const cwd = opts.cwd ?? process.cwd();
	const warnings: string[] = [];
	const errors: string[] = [];

	const fromEnv = env.HER_EXEC?.trim();
	let backend: ExecBackend =
		fromEnv && isExecBackend(fromEnv) ? fromEnv : (readProjectExecBackend(cwd) ?? defaultBackend(platform));

	if (fromEnv && !isExecBackend(fromEnv)) {
		errors.push(`Invalid HER_EXEC="${fromEnv}"`);
		backend = defaultBackend(platform);
	}

	const cap = execCapabilities[backend];
	let effective: string = backend;

	if (platform === "win32" && cap.requiresWslOnWindows) {
		if (env.HER_EXEC_WSL === "1" || env.HER_EXEC_FORCE_WSL === "1") {
			effective = `wsl-${backend}`;
			warnings.push(`${backend} on Windows requires WSL (HER_EXEC_WSL=1)`);
		} else if (backend !== "native") {
			errors.push(
				`${backend} is not available on Windows native. Set HER_EXEC=native, HER_EXEC_WSL=1, or use remote/docker launcher.`,
			);
			effective = "native-unavailable-requested";
			backend = "native";
		}
	}

	if (backend === "bash-sandbox" && platform === "darwin") {
		warnings.push("bash-sandbox uses sandbox-exec on macOS");
	}
	if (backend === "bash-sandbox" && platform === "linux") {
		warnings.push("bash-sandbox requires bubblewrap (bwrap) on Linux");
	}

	return { backend, effective, warnings, errors };
}

export function currentExecBackendLabel(opts?: ResolveExecOptions): string {
	return resolveExec(opts).effective;
}
