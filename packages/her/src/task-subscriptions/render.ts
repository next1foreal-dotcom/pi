import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Display the report without changing the fenced data stored in the model context. */
export function renderSubscriptionReport(content: string, outputPad: number): Text | undefined {
	const startMarker = "[BEGIN TASK REPORT DATA]";
	const endMarker = "[END TASK REPORT DATA]";
	const start = content.indexOf(startMarker);
	const end = content.lastIndexOf(endMarker);
	if (start < 0 || end <= start) return undefined;
	const title = content.split("\n", 1)[0];
	const body = content.slice(start + startMarker.length, end).trim();
	return new Text(stripVTControlCharacters(`${title}\n模型报告 · 未独立验收\n\n${body}`), outputPad, 1);
}

export function registerTaskSubscriptionRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(
		"her-task-subscription-wake",
		(_message, { outputPad }) => new Text("后台任务已结束，正在整理订阅报告…", outputPad, 1),
	);
	pi.registerMessageRenderer("her-task-subscription-result", (message, { outputPad }) =>
		typeof message.content === "string" ? renderSubscriptionReport(message.content, outputPad) : undefined,
	);
}
