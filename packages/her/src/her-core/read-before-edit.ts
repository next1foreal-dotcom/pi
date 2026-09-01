/**
 * G-401 — session-local read-before-edit guard (pure logic, no pi API).
 *
 * Tracks files this session has already read or written. An `edit` (or any
 * tool whose name contains "edit") of a path not in that set is blocked so
 * the model cannot invent a patch against a file it never looked at.
 */

import { resolve } from "node:path";

const READ_TOOLS = new Set(["read", "write"]);
const PATH_KEYS = ["path", "file_path", "absolutePath"] as const;

export type GuardVerdict = { block: false } | { block: true; reason: string };

export type ReadGuard = {
	checkToolCall(toolName: string, input: unknown): GuardVerdict;
	noteToolCall(toolName: string, input: unknown): void;
};

export function normalizeFilePath(filePath: string): string {
	return resolve(filePath).replace(/^([A-Za-z]):/, (_, letter: string) => `${letter.toLowerCase()}:`);
}

function extractPath(input: unknown): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	for (const key of PATH_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

function isEditTool(toolName: string): boolean {
	return toolName.toLowerCase().includes("edit");
}

function isReadTool(toolName: string): boolean {
	return READ_TOOLS.has(toolName.toLowerCase());
}

function unreadReason(filePath: string): string {
	return `未读先改被拦:本轮会话没有读过 ${filePath}。先 read 它再改——这条护栏防的是"凭想象改文件"。(移植自 Claude Code 的 Edit 前置)`;
}

export function createReadGuard(): ReadGuard {
	const readPaths = new Set<string>();
	return {
		noteToolCall(toolName: string, input: unknown): void {
			if (!isReadTool(toolName)) return;
			const raw = extractPath(input);
			if (raw === undefined) return;
			readPaths.add(normalizeFilePath(raw));
		},
		checkToolCall(toolName: string, input: unknown): GuardVerdict {
			if (!isEditTool(toolName)) return { block: false };
			const raw = extractPath(input);
			if (raw === undefined) return { block: false };
			if (readPaths.has(normalizeFilePath(raw))) return { block: false };
			return { block: true, reason: unreadReason(raw) };
		},
	};
}
