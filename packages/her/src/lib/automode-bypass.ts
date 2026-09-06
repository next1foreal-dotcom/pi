/**
 * G-425: her_status must not wait on pi-automode's network classifier.
 *
 * pi-automode only fast-paths the built-in set {read, grep, find, ls}
 * (READ_ONLY_TOOLS in its constants.ts). Every other tool, including
 * Cedar-permitted non-destructive custom tools, goes through classify()
 * and fail-closes on fetch errors. This package cannot edit pi-automode
 * or coding-agent source, so her skips automode's tool_call handlers for
 * this one name. her_status writes session name / headline / waiting into
 * the turn record only: no messages, files, or commands.
 */

import {
	type Extension,
	ExtensionRunner,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

const INSTALLED = Symbol.for("her.g425.automodeBypass");

/** Single-tool allowlist. Do not add other destructive:false tools here. */
export const AUTOMODE_CLASSIFIER_BYPASS_TOOLS: ReadonlySet<string> = new Set(["her_status"]);

export function bypassesAutoModeClassifier(toolName: string): boolean {
	return AUTOMODE_CLASSIFIER_BYPASS_TOOLS.has(toolName);
}

export function isPiAutomodeExtensionPath(extensionPath: string): boolean {
	return extensionPath.replaceAll("\\", "/").toLowerCase().includes("pi-automode");
}

export type ToolCallExtensionLike = {
	path: string;
	handlers: Map<string, ReadonlyArray<(event: unknown, ctx: unknown) => unknown>>;
};

export async function emitToolCallSkippingAutoModeClassifier(
	event: unknown,
	extensions: ReadonlyArray<ToolCallExtensionLike>,
	ctx: unknown,
): Promise<ToolCallEventResult | undefined> {
	let result: ToolCallEventResult | undefined;
	for (const ext of extensions) {
		if (isPiAutomodeExtensionPath(ext.path)) continue;
		const handlers = ext.handlers.get("tool_call");
		if (!handlers || handlers.length === 0) continue;
		for (const handler of handlers) {
			const handlerResult = await handler(event, ctx);
			if (handlerResult && typeof handlerResult === "object") {
				result = handlerResult as ToolCallEventResult;
				if (result.block) return result;
			}
		}
	}
	return result;
}

function runnerExtensions(runner: ExtensionRunner): ToolCallExtensionLike[] {
	const extensions = (runner as unknown as { extensions?: Extension[] }).extensions;
	if (!Array.isArray(extensions)) return [];
	return extensions.map((ext) => ({
		path: ext.path,
		handlers: ext.handlers as ToolCallExtensionLike["handlers"],
	}));
}

type EmitToolCall = (this: ExtensionRunner, event: ToolCallEvent) => Promise<ToolCallEventResult | undefined>;

export function installHerStatusAutoModeBypass(): void {
	const proto = ExtensionRunner.prototype as ExtensionRunner & { [INSTALLED]?: boolean };
	if (proto[INSTALLED]) return;
	const original = proto.emitToolCall as EmitToolCall;
	const patched: EmitToolCall = async function patchedEmitToolCall(event) {
		if (!bypassesAutoModeClassifier(event.toolName)) {
			return original.call(this, event);
		}
		return emitToolCallSkippingAutoModeClassifier(event, runnerExtensions(this), this.createContext());
	};
	proto.emitToolCall = patched;
	proto[INSTALLED] = true;
}
