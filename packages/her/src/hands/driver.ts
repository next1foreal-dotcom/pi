import { spawn } from "node:child_process";

export const CUA_DRIVER_M0 = {
	version: "0.7.0",
	binary: "cua-driver",
	callCommand: "call",
	callArgShape: "cua-driver call <tool> <json-args>",
	powershellJsonMode: "pipe JSON via stdin on Windows PowerShell 5.1",
	snapshotTool: "get_window_state",
	snapshotRequiredArgs: ["pid", "window_id"],
	actionTools: {
		click: "click",
		doubleClick: "double_click",
		rightClick: "right_click",
		scroll: "scroll",
		typeText: "type_text",
		pressKey: "press_key",
		hotkey: "hotkey",
		drag: "drag",
	},
	defaultDeliveryMode: "background",
	backgroundUnavailableSignal: "background_unavailable",
	notepadSnapshotCommand:
		'\'{"pid":30048,"window_id":25103322,"include_screenshot":false,"max_elements":80}\' | cua-driver call get_window_state',
	evidenceFile: "pi-package/skills/her-hands-desktop/evidence/cua-driver-0.7.0-m0.txt",
} as const;

export type CuaDriverToolName =
	| typeof CUA_DRIVER_M0.snapshotTool
	| (typeof CUA_DRIVER_M0.actionTools)[keyof typeof CUA_DRIVER_M0.actionTools];

export interface DriverResult {
	ok: boolean;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface HandsDriver {
	run(args: string[], opts?: { timeoutMs?: number }): Promise<DriverResult>;
}

export class CuaCliDriver implements HandsDriver {
	readonly #binary: string;
	readonly #defaultTimeoutMs: number;

	constructor(opts: { binary: string; defaultTimeoutMs: number }) {
		this.#binary = opts.binary;
		this.#defaultTimeoutMs = opts.defaultTimeoutMs;
	}

	run(args: string[], opts: { timeoutMs?: number } = {}): Promise<DriverResult> {
		const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs;
		return new Promise((resolve, reject) => {
			const child = spawn(this.#binary, args, { windowsHide: true });
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, timeoutMs);

			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			});
			child.once("close", (exitCode) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr, timedOut });
			});
		});
	}
}

export interface FakeDriverCase {
	match: string[] | RegExp;
	result: DriverResult;
}

export class FakeDriver implements HandsDriver {
	readonly calls: string[][] = [];
	#cases: FakeDriverCase[];

	constructor(cases: FakeDriverCase[]) {
		this.#cases = [...cases];
	}

	async run(args: string[]): Promise<DriverResult> {
		this.calls.push([...args]);
		const index = this.#cases.findIndex((item) => matches(item.match, args));
		if (index === -1) throw new Error(`FakeDriver has no result for: ${args.join(" ")}`);
		const [item] = this.#cases.splice(index, 1);
		return item.result;
	}
}

function matches(match: string[] | RegExp, args: string[]): boolean {
	if (match instanceof RegExp) return match.test(args.join(" "));
	return match.length === args.length && match.every((value, index) => value === args[index]);
}
