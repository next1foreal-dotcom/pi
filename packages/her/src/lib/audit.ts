import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface AuditEntry {
	cost?: {
		model?: string;
		outputTokens?: number;
		provider?: string;
		purpose?: string;
		usd: number;
	};
	ts: string;
	tool: string;
	toolCallId?: string;
	verdict: "ALLOW" | "DENY";
	rule: string | null;
	reason?: string;
	context?: Record<string, unknown>;
}

/** Collapse an absolute filesystem path to a store-relative or redacted token. */
export function redactAuditPath(value: string): string {
	const slash = value.replaceAll("\\", "/");
	const marker = "her-memory/";
	const idx = slash.toLowerCase().indexOf(marker);
	if (idx >= 0) return `her-memory/${slash.slice(idx + marker.length)}`;
	if (/^[a-zA-Z]:\//.test(slash) || slash.startsWith("//") || slash.startsWith("/")) return "<redacted-abs>";
	return value;
}

function redactAuditValue(value: unknown): unknown {
	if (typeof value === "string") return redactAuditPath(value);
	if (Array.isArray(value)) return value.map(redactAuditValue);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, nested] of Object.entries(value)) out[key] = redactAuditValue(nested);
		return out;
	}
	return value;
}

export function appendAuditLog(
	entry: AuditEntry,
	memoryDir = process.env.HER_MEMORY_DIR ?? resolve(process.cwd(), "..", "her-memory"),
): void {
	const auditDir = resolve(memoryDir, "audit");
	mkdirSync(auditDir, { recursive: true });

	const date = entry.ts.slice(0, 10);
	const safe: AuditEntry = {
		...entry,
		reason: typeof entry.reason === "string" ? redactAuditPath(entry.reason) : entry.reason,
		context: entry.context ? (redactAuditValue(entry.context) as Record<string, unknown>) : entry.context,
	};
	appendFileSync(resolve(auditDir, `${date}.jsonl`), `${JSON.stringify(safe)}\n`, "utf8");
}
