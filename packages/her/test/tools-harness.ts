import { writeFileSync } from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerFileToolkit, type ToolkitDeps } from "../src/tools/index.ts";
import type { ToolLocation, ToolLocator, ToolName } from "../src/tools/locate.ts";
import type { CommandRunner, RunOptions, RunResult } from "../src/tools/runner.ts";

export interface RunCall {
	file: string;
	args: string[];
	opts: RunOptions;
}

/** Locator whose "installed" tools are the keys of the map; everything else is missing. */
export class FakeLocator implements ToolLocator {
	readonly #present: Map<ToolName, string>;

	constructor(present: Partial<Record<ToolName, string>> = {}) {
		this.#present = new Map(Object.entries(present) as Array<[ToolName, string]>);
	}

	locate(tool: ToolName): ToolLocation {
		return { tool, command: tool, path: this.#present.get(tool) ?? null, winget: `winget install --id ${tool}` };
	}
}

export type FakeRunOutcome = Partial<RunResult> & {
	/** Files the "binary" should create, so the tool's output checks pass. */
	writeFiles?: Array<{ path: string; content?: string; bytes?: number }>;
};

export type RunHandler = (call: RunCall) => FakeRunOutcome;

/** Records every invocation and returns canned results; never spawns anything. */
export class FakeRunner implements CommandRunner {
	readonly calls: RunCall[] = [];
	readonly #handler: RunHandler;

	constructor(handler: RunHandler = () => ({})) {
		this.#handler = handler;
	}

	async run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
		const call: RunCall = { file, args, opts };
		this.calls.push(call);
		const outcome = this.#handler(call);
		for (const spec of outcome.writeFiles ?? []) {
			writeFileSync(spec.path, spec.content ?? "x".repeat(spec.bytes ?? 8));
		}
		return {
			ok: outcome.ok ?? true,
			exitCode: outcome.exitCode ?? 0,
			stdout: outcome.stdout ?? "",
			stderr: outcome.stderr ?? "",
			timedOut: outcome.timedOut ?? false,
			canceled: outcome.canceled ?? false,
		};
	}
}

export function toolHarness(deps: ToolkitDeps): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerFileToolkit(pi, deps);
	return tools;
}

export async function runTool(tool: ToolDefinition | undefined, params: Record<string, unknown>): Promise<string> {
	if (!tool) throw new Error("tool not registered");
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ type: string; text: string }>;
	};
	return result.content[0]?.text ?? "";
}
