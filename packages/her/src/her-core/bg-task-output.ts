/**
 * Paginated log read with UTF-8 boundary safety (appendix F.4).
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { loadBgTask, tasksDir } from "./bg-task-record.ts";
import { redactSecrets } from "./store.ts";

export type TaskOutputChunk = {
	chunk: string;
	offset: number;
	nextOffset: number;
	eof: boolean;
	totalBytes: number;
};

export function readLogChunk(buf: Buffer, n: number, offset: number): { chunk: string; nextOffset: number } {
	let end = n;
	for (let back = 0; back < 4 && end > 0; back++) {
		const b = buf[end - 1];
		if ((b & 0x80) === 0x00) break;
		if ((b & 0xc0) === 0x80) {
			end--;
			continue;
		}
		const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
		if (n - (end - 1) < need) end--;
		break;
	}
	return {
		chunk: buf.subarray(0, end).toString("utf8"),
		nextOffset: offset + end,
	};
}

export async function herTaskOutput(
	memoryRoot: string,
	id: string,
	options?: { offset?: number; limit?: number },
): Promise<TaskOutputChunk> {
	const loaded = await loadBgTask(memoryRoot, id);
	if (!loaded) throw new Error(`task not found: ${id}`);
	if (loaded.record.host && loaded.record.host !== osHostname()) {
		throw new Error(`日志在 ${loaded.record.host} 上，本机不可见`);
	}

	const logPath = join(tasksDir(memoryRoot), `${id}.log`);
	if (!existsSync(logPath)) {
		return { chunk: "", offset: 0, nextOffset: 0, eof: true, totalBytes: 0 };
	}

	const offset = Math.max(0, options?.offset ?? 0);
	const limit = Math.min(Math.max(1, options?.limit ?? 8192), 65536);
	const fd = openSync(logPath, "r");
	try {
		const totalBytes = fstatSync(fd).size;
		const buf = Buffer.alloc(limit);
		const n = readSync(fd, buf, 0, limit, offset);
		const { chunk, nextOffset } = readLogChunk(buf, n, offset);
		return {
			chunk: redactSecrets(chunk),
			offset,
			nextOffset,
			eof: nextOffset >= totalBytes,
			totalBytes,
		};
	} finally {
		closeSync(fd);
	}
}
