/**
 * G-121 — terminal log truncation (appendix A.8): keep head + tail.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tasksDir } from "./bg-task-record.ts";

export type LogTruncateConfig = {
	logCapBytes: number;
	logHeadBytes: number;
	logTailBytes: number;
};

export const DEFAULT_LOG_TRUNCATE: LogTruncateConfig = {
	logCapBytes: 2_097_152,
	logHeadBytes: 262_144,
	logTailBytes: 786_432,
};

/** Pure: truncate buffer to head+tail with marker. */
export function truncateLogBuffer(
	buf: Buffer,
	cfg: LogTruncateConfig = DEFAULT_LOG_TRUNCATE,
): { buffer: Buffer; truncated: boolean; removed: number } {
	if (buf.length <= cfg.logCapBytes) {
		return { buffer: buf, truncated: false, removed: 0 };
	}
	const head = buf.subarray(0, cfg.logHeadBytes);
	const tail = buf.subarray(buf.length - cfg.logTailBytes);
	const removed = buf.length - cfg.logHeadBytes - cfg.logTailBytes;
	const marker = Buffer.from(`\n[... truncated ${removed} bytes ...]\n`, "utf8");
	return {
		buffer: Buffer.concat([head, marker, tail]),
		truncated: true,
		removed,
	};
}

/** Truncate on-disk log after task reaches a terminal status. */
export function truncateTaskLogIfNeeded(
	memoryRoot: string,
	id: string,
	cfg: LogTruncateConfig = DEFAULT_LOG_TRUNCATE,
): { truncated: boolean; removed: number } {
	const path = join(tasksDir(memoryRoot), `${id}.log`);
	if (!existsSync(path)) return { truncated: false, removed: 0 };
	const size = statSync(path).size;
	if (size <= cfg.logCapBytes) return { truncated: false, removed: 0 };
	const buf = readFileSync(path);
	const result = truncateLogBuffer(buf, cfg);
	if (result.truncated) writeFileSync(path, result.buffer);
	return { truncated: result.truncated, removed: result.removed };
}
