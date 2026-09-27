import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SIDE_CHAT_GUARD_PREFIX = "[her-side-chat-guard] ";
const ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function pathIsWithin(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export async function sideChatToolViolation(
	rootPath: string,
	toolName: string,
	input: Record<string, unknown>,
	canonicalize: (path: string) => Promise<string> = realpath,
	cwd: string = rootPath,
): Promise<string | null> {
	if (!ALLOWED_TOOLS.has(toolName)) return `tool ${toolName} is not read-only`;
	const rawPath = typeof input.path === "string" && input.path.trim() ? input.path.trim() : ".";
	try {
		const [root, target] = await Promise.all([canonicalize(resolve(rootPath)), canonicalize(resolve(cwd, rawPath))]);
		return pathIsWithin(root, target) ? null : `path ${rawPath} escapes the authorized workspace`;
	} catch {
		return `path ${rawPath} could not be verified inside the authorized workspace`;
	}
}

export default function sideChatGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const root = process.env.HER_SIDE_CHAT_ROOT?.trim() || ctx.cwd;
		const violation = await sideChatToolViolation(root, event.toolName, event.input, realpath, ctx.cwd);
		if (!violation) return undefined;
		console.error(`${SIDE_CHAT_GUARD_PREFIX}${violation}`);
		return { block: true, reason: violation, terminate: true };
	});
}
