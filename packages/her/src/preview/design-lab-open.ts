import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DESIGN_LAB_PORT = 5180;
export const DESIGN_LAB_URL = "http://localhost:5180";
export const DESIGN_LAB_WAIT_MS = 30_000;
export const DESIGN_LAB_POLL_MS = 250;
/** Studio's real listen port. Other preview tools keep 3000; this tool does not. */
export const DEFAULT_STUDIO_UI_BASE_URL = "http://127.0.0.1:4321";

export type DesignLabReadyStatus = "opened" | "already-running";

export type DesignLabReadyResult =
	| { ok: true; status: DesignLabReadyStatus }
	| { ok: false; status: "failed"; reason: string };

export interface DesignLabStartInput {
	args: string[];
	batContents: string;
	batPath: string;
	command: string;
	logPath: string;
}

export interface DesignLabOpenDeps {
	labPath?: string;
	now?: () => number;
	packageExists?: boolean | ((labPath: string) => boolean);
	pollMs?: number;
	probe?: (port: number) => Promise<boolean>;
	signal?: AbortSignal;
	sleep?: (ms: number) => Promise<void>;
	tmpDir?: string;
	waitMs?: number;
	writeAndStart?: (input: DesignLabStartInput) => Promise<void>;
}

export function resolveStudioUiBase(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
	const value = env.HER_UI_BASE_URL?.trim();
	return value ? value : DEFAULT_STUDIO_UI_BASE_URL;
}

export function buildDesignLabBat(labAbsPath: string, logAbsPath: string): string {
	return `@echo off\r\npnpm -C "${labAbsPath}" dev > "${logAbsPath}" 2>&1\r\n`;
}

export function nestedStartArgs(batAbsPath: string): { args: string[]; command: string } {
	return { command: "cmd", args: ["/c", "start", "", "/min", batAbsPath] };
}

export function defaultDesignLabPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "..", "..", "packages", "design-lab");
}

export function probeListeningPort(port: number, host = "127.0.0.1"): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host });
		let settled = false;
		const done = (value: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(value);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(500, () => done(false));
	});
}

export async function ensureDesignLabReady(deps: DesignLabOpenDeps = {}): Promise<DesignLabReadyResult> {
	const port = DESIGN_LAB_PORT;
	const probe = deps.probe ?? ((candidate) => probeListeningPort(candidate));
	if (await probe(port)) return { ok: true, status: "already-running" };

	const labPath = deps.labPath ?? defaultDesignLabPath();
	if (!labPackagePresent(labPath, deps.packageExists)) {
		return { ok: false, status: "failed", reason: `design-lab package not found at ${labPath}` };
	}

	const stamp = String((deps.now ?? Date.now)());
	const dir = deps.tmpDir ?? tmpdir();
	const batPath = join(dir, `her-design-lab-${stamp}.bat`);
	const logPath = join(dir, `her-design-lab-${stamp}.log`);
	const batContents = buildDesignLabBat(labPath, logPath);
	const start = nestedStartArgs(batPath);
	const writeAndStart = deps.writeAndStart ?? defaultWriteAndStart;
	try {
		await writeAndStart({
			args: start.args,
			batContents,
			batPath,
			command: start.command,
			logPath,
		});
	} catch (error) {
		return { ok: false, status: "failed", reason: errorMessage(error) };
	}

	const waitMs = deps.waitMs ?? DESIGN_LAB_WAIT_MS;
	const pollMs = deps.pollMs ?? DESIGN_LAB_POLL_MS;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const deadline = now() + waitMs;
	while (now() < deadline) {
		if (deps.signal?.aborted) return { ok: false, status: "failed", reason: "aborted" };
		if (await probe(port)) return { ok: true, status: "opened" };
		await sleep(pollMs);
	}
	if (await probe(port)) return { ok: true, status: "opened" };
	return {
		ok: false,
		status: "failed",
		reason: `port ${port} did not start listening within ${waitMs}ms`,
	};
}

async function defaultWriteAndStart(input: DesignLabStartInput): Promise<void> {
	await writeFile(input.batPath, input.batContents, "utf8");
	const child = spawn(input.command, input.args, {
		detached: true,
		shell: false,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
}

function labPackagePresent(labPath: string, override: DesignLabOpenDeps["packageExists"]): boolean {
	if (typeof override === "boolean") return override;
	if (typeof override === "function") return override(labPath);
	return existsSync(join(labPath, "package.json"));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
