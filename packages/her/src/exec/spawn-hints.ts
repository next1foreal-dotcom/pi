import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execCapabilities } from "./capabilities.ts";
import { type ResolveExecOptions, resolveExec } from "./resolve.ts";
import type { ExecSpawnHints } from "./types.ts";

export interface SpawnHintsOptions extends ResolveExecOptions {
	piMonoRoot?: string;
}

function piRoot(opts: SpawnHintsOptions): string {
	return opts.piMonoRoot ?? process.env.HER_PI_DIR?.trim() ?? resolve(process.cwd(), "..");
}

export function buildExecSpawnHints(opts: SpawnHintsOptions = {}): ExecSpawnHints {
	const resolution = resolveExec(opts);
	const root = piRoot(opts);
	const cap = execCapabilities[resolution.backend];
	const extraExtensions: string[] = [];
	const extraEnv: Record<string, string> = {};
	const extraArgs: string[] = [];

	if (cap.piExtensionDir) {
		const segments = cap.piExtensionDir.split("/");
		const abs = resolve(root, ...segments);
		if (existsSync(abs)) {
			extraExtensions.push(abs);
		}
	}

	if (resolution.backend === "docker") {
		extraEnv.HER_EXEC_LAUNCHER = "docker";
	}

	if (resolution.backend === "ssh") {
		const host = opts.env?.HER_SSH_HOST ?? process.env.HER_SSH_HOST;
		if (host) extraEnv.HER_SSH_HOST = host;
	}

	if (resolution.backend === "remote") {
		extraEnv.HER_EXEC_LAUNCHER = "remote";
	}

	if (resolution.effective.startsWith("wsl-")) {
		extraEnv.HER_EXEC_WSL = "1";
	}

	return {
		backend: resolution.backend,
		effective: resolution.effective,
		extraExtensions,
		extraEnv,
		extraArgs,
	};
}

/** Alias for Studio / verify script discovery. */
export function resolveExecSpawnHints(opts: SpawnHintsOptions = {}): ExecSpawnHints {
	return buildExecSpawnHints(opts);
}
