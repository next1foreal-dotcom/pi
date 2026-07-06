import type { Memory } from "../her-core/memory.ts";
import type { HandsActionKind } from "./policy.ts";

export interface HandsTrailEntry {
	ts: string;
	action: HandsActionKind;
	targetProcess: string;
	deliveryMode: "background" | "foreground";
	outcome: "ok" | "denied" | "error";
	detail: string;
}

export function renderTrailCard(taskLabel: string, entries: HandsTrailEntry[]): string {
	const time = formatTime(entries[0]?.ts ?? new Date().toISOString());
	const lines = [`## ${time} · 桌面操作:${taskLabel}`, "", "### 动作"];
	for (const entry of entries) lines.push(renderEntry(entry));
	lines.push("", "### 拒绝记录");
	const denied = entries.filter((entry) => entry.outcome === "denied");
	if (denied.length === 0) {
		lines.push("无");
	} else {
		for (const entry of denied) lines.push(renderEntry(entry));
	}
	return `${lines.join("\n")}\n`;
}

export async function recordTrail(mem: Memory, taskLabel: string, entries: HandsTrailEntry[]): Promise<string> {
	return await mem.capture(renderTrailCard(taskLabel, entries), {
		privacy: "private",
		provenance: "her-acted",
		project: "hands-desktop",
		type: "hands_trail",
	});
}

function renderEntry(entry: HandsTrailEntry): string {
	return `- ${formatTime(entry.ts)} [${entry.outcome}] ${entry.action} ${entry.targetProcess} ${entry.deliveryMode} - ${oneLine(
		entry.detail,
	)}`;
}

function formatTime(ts: string): string {
	const date = new Date(ts);
	if (Number.isNaN(date.getTime())) return ts.slice(11, 16) || "00:00";
	return date.toISOString().slice(11, 16);
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
