import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface AuditEntry {
	ts: string;
	tool: string;
	toolCallId?: string;
	verdict: "ALLOW" | "DENY";
	rule: string | null;
	reason?: string;
	context?: Record<string, unknown>;
}

export function appendAuditLog(entry: AuditEntry): void {
	const memoryDir = process.env.HER_MEMORY_DIR ?? resolve(process.cwd(), "..", "her-memory");
	const auditDir = resolve(memoryDir, "audit");
	mkdirSync(auditDir, { recursive: true });

	const date = entry.ts.slice(0, 10);
	appendFileSync(resolve(auditDir, `${date}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}
