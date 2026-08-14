import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CompletionMeta, ModelLike } from "./model.ts";
import { appendText } from "./store.ts";

export type OpName = "consolidate" | "reingest" | "synthesize";

export interface OpStartRecord {
	op: OpName;
	opId: string;
	phase: "start";
	ts: string;
}

export interface OpEndError {
	messageHead: string;
	name: string;
}

export interface OpEndRecord {
	error?: OpEndError;
	model?: CompletionMeta;
	ok: boolean;
	op: OpName;
	opId: string;
	phase: "end";
	ts: string;
}

export interface OpBracketContext {
	noteModel(meta: CompletionMeta | undefined): void;
	readonly opId: string;
}

export function opsLedgerPath(root: string): string {
	return join(root, "audit", "ops.jsonl");
}

export function newOpId(): string {
	return randomUUID();
}

export function completionMetaOf(model?: ModelLike): CompletionMeta | undefined {
	const last = model?.lastCompletion;
	if (!last) return undefined;
	if (!last.finishReason && !last.usage && !last.model && !last.provider) return undefined;
	return { ...last };
}

/**
 * Returns opIds whose start has no matching end and whose start timestamp is older than timeoutMs.
 * Malformed JSONL lines are skipped. `her doctor` DR-08 reads audit/ops.jsonl through this.
 */
export function detectOrphanBrackets(lines: string[], nowMs: number, timeoutMs: number): string[] {
	const open = new Map<string, number>();
	const seenOrder: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let rec: { opId?: unknown; phase?: unknown; ts?: unknown };
		try {
			rec = JSON.parse(trimmed) as typeof rec;
		} catch {
			continue;
		}
		if (typeof rec.opId !== "string" || rec.opId.length === 0) continue;
		if (rec.phase === "start") {
			if (!open.has(rec.opId)) seenOrder.push(rec.opId);
			const startMs = typeof rec.ts === "string" ? Date.parse(rec.ts) : Number.NaN;
			open.set(rec.opId, Number.isFinite(startMs) ? startMs : 0);
		} else if (rec.phase === "end") {
			open.delete(rec.opId);
		}
	}
	const orphans: string[] = [];
	for (const opId of seenOrder) {
		const startMs = open.get(opId);
		if (startMs === undefined) continue;
		if (nowMs - startMs > timeoutMs) orphans.push(opId);
	}
	return orphans;
}

export async function withOpBracket<T>(
	root: string,
	op: OpName,
	fn: (ctx: OpBracketContext) => Promise<T>,
): Promise<T> {
	const opId = newOpId();
	let ok = false;
	let captured: OpEndError | undefined;
	let modelMeta: CompletionMeta | undefined;
	const ctx: OpBracketContext = {
		opId,
		noteModel(meta) {
			modelMeta = meta && Object.keys(meta).length > 0 ? { ...meta } : undefined;
		},
	};
	await writeOpsLine(root, { op, opId, phase: "start", ts: new Date().toISOString() } satisfies OpStartRecord);
	try {
		const result = await fn(ctx);
		ok = true;
		return result;
	} catch (error) {
		captured = { name: errorName(error), messageHead: errorHead(error) };
		throw error;
	} finally {
		const end: OpEndRecord = {
			op,
			opId,
			phase: "end",
			ts: new Date().toISOString(),
			ok,
			...(captured ? { error: captured } : {}),
			...(modelMeta ? { model: modelMeta } : {}),
		};
		await writeOpsLine(root, end);
	}
}

async function writeOpsLine(root: string, record: OpStartRecord | OpEndRecord): Promise<void> {
	try {
		await appendText(opsLedgerPath(root), `${JSON.stringify(record)}\n`);
	} catch (error) {
		console.warn(`[her] ops ledger write failed (${record.phase}): ${errorHead(error)}`);
	}
}

function errorName(error: unknown): string {
	return error instanceof Error && error.name ? error.name : "Error";
}

function errorHead(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 200);
}
