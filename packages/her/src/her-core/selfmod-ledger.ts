import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendSelfmodTransition } from "./event-history.ts";
import type { SelfModRunRecord, SelfModStage } from "./selfmod-types.ts";
import { readText, retryOnFsContention } from "./store.ts";

export function selfmodLedgerPath(memoryDir: string): string {
	return join(memoryDir, "audit", "selfmod.jsonl");
}

export async function readSelfmodRecords(memoryDir: string): Promise<SelfModRunRecord[]> {
	const text = await readText(selfmodLedgerPath(memoryDir));
	if (!text) return [];
	const rows: SelfModRunRecord[] = [];
	for (const line of text.split(/\n/)) {
		if (line.trim() === "") continue;
		try {
			rows.push(JSON.parse(line) as SelfModRunRecord);
		} catch {
			/* skip corrupt line; parser never blocks the next append */
		}
	}
	return rows;
}

export function latestSelfmodRecord(rows: SelfModRunRecord[], id: string): SelfModRunRecord | undefined {
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].proposal.id === id) return rows[i];
	}
	return undefined;
}

export async function appendSelfmodSnapshot(
	memoryDir: string,
	record: SelfModRunRecord,
	from: SelfModStage | "start",
	extra?: Record<string, unknown>,
): Promise<void> {
	await appendLedgerLine(selfmodLedgerPath(memoryDir), `${JSON.stringify(record)}\n`);
	await appendSelfmodTransition(
		{
			id: record.proposal.id,
			stage: record.stage,
			from,
			...extra,
		},
		undefined,
		memoryDir,
	);
}

async function appendLedgerLine(path: string, line: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await retryOnFsContention(
		async () => {
			const fh = await open(path, "a");
			try {
				await fh.appendFile(line, "utf8");
				await fh.sync();
			} finally {
				await fh.close();
			}
		},
		{ label: "selfmod-ledger" },
	);
}
