import type { ToolCallSummary } from "./score.ts";

function toolNameFromEvent(event: Record<string, unknown>): string | undefined {
	if (event.type === "tool_execution_start" && typeof event.toolName === "string") return event.toolName;
	if (event.type === "tool_call" && typeof event.name === "string") return event.name;
	if (event.type === "tool_call_start" && typeof event.tool === "string") return event.tool;
	const nested = event.toolCall;
	if (isRecord(nested) && typeof nested.name === "string") return nested.name;
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolCalls(ndjson: string): ToolCallSummary {
	const counts: Record<string, number> = {};
	const order: string[] = [];
	const lines = ndjson.split(/\r?\n/).filter((line) => line.trim());
	for (const [index, line] of lines.entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`invalid NDJSON at line ${index + 1}: ${detail}`);
		}
		if (!isRecord(parsed)) continue;
		const name = toolNameFromEvent(parsed);
		if (!name) continue;
		counts[name] = (counts[name] ?? 0) + 1;
		order.push(name);
	}
	return { counts, order };
}
