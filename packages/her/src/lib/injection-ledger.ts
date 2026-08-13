import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { redactAuditPath } from "./audit.ts";

/** Narrative files assembled into the her-context system-prompt block. */
export const CONTEXT_INJECTION_SOURCES = [
	"narrative/CONTEXT.md",
	"narrative/FACTS.md",
	"narrative/SOUL.md",
	"narrative/SAMANTHA.md",
	"narrative/CHOICE-MODEL.md",
] as const;

export type InjectionKind = "context" | "recall" | "mirror" | "world" | (string & {});

export interface InjectionBlock {
	kind: InjectionKind;
	sources?: string[];
	digest: string;
	bytes: number;
}

export interface InjectionRecord {
	ts: string;
	session?: string;
	blocks: InjectionBlock[];
}

export interface InjectionBlockInput {
	kind: InjectionKind;
	content: string;
	sources?: string[];
}

/** sessionId -> kind -> last original content digest */
const previousDigests = new Map<string, Map<string, string>>();

export function contentDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function isInjectDedupeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HER_INJECT_DEDUPE === "1";
}

export function unchangedInjectionMarker(kind: string, digest: string): string {
	return `[her-context unchanged: ${kind} digest ${digest}]`;
}

/**
 * Pure per-block dedupe. First injection of a session+kind (no previous digest)
 * always passes through. Repeat of the same digest becomes a one-line marker.
 * Flag off is a no-op.
 */
export function applyBlockDedupe(input: {
	enabled: boolean;
	kind: string;
	content: string;
	digest: string;
	previousDigest: string | undefined;
}): { text: string; unchanged: boolean } {
	if (!input.enabled || input.previousDigest === undefined) {
		return { text: input.content, unchanged: false };
	}
	if (input.previousDigest === input.digest) {
		return { text: unchangedInjectionMarker(input.kind, input.digest), unchanged: true };
	}
	return { text: input.content, unchanged: false };
}

export function resetInjectionDedupeState(): void {
	previousDigests.clear();
}

export function injectionLedgerPath(memoryDir: string): string {
	return join(memoryDir, "audit", "context-injections.jsonl");
}

function ledgerErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function toBlock(input: InjectionBlockInput): InjectionBlock {
	const sources = input.sources?.map(redactAuditPath).filter(Boolean);
	const block: InjectionBlock = {
		kind: input.kind,
		digest: contentDigest(input.content),
		bytes: Buffer.byteLength(input.content, "utf8"),
	};
	if (sources && sources.length > 0) block.sources = sources;
	return block;
}

/** Append one JSONL line to the store's audit/context-injections.jsonl. Throws on I/O errors. */
export function appendInjectionRecord(opts: {
	memoryDir: string;
	session?: string;
	blocks: InjectionBlockInput[];
	ts?: string;
}): InjectionRecord {
	const ts = opts.ts ?? new Date().toISOString();
	const record: InjectionRecord = {
		ts,
		blocks: opts.blocks.map(toBlock),
	};
	if (opts.session) record.session = opts.session;
	const path = injectionLedgerPath(opts.memoryDir);
	mkdirSync(join(opts.memoryDir, "audit"), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

/**
 * Dedupe (optional) then log. Ledger failures warn and never throw; a broken
 * ledger must not silence her-context injection.
 */
export function injectLoggedContent(opts: {
	memoryDir: string;
	session?: string;
	kind: InjectionKind;
	content: string;
	sources?: string[];
	extraBlocks?: InjectionBlockInput[];
}): string {
	const digest = contentDigest(opts.content);
	let text = opts.content;
	try {
		if (isInjectDedupeEnabled() && opts.session) {
			const byKind = previousDigests.get(opts.session) ?? new Map<string, string>();
			const previousDigest = byKind.get(opts.kind);
			text = applyBlockDedupe({
				enabled: true,
				kind: opts.kind,
				content: opts.content,
				digest,
				previousDigest,
			}).text;
			byKind.set(opts.kind, digest);
			previousDigests.set(opts.session, byKind);
		}
	} catch (error) {
		console.warn(`[her] injection dedupe skipped: ${ledgerErrorMessage(error)}`);
		text = opts.content;
	}

	try {
		appendInjectionRecord({
			memoryDir: opts.memoryDir,
			session: opts.session,
			blocks: [{ kind: opts.kind, content: opts.content, sources: opts.sources }, ...(opts.extraBlocks ?? [])],
		});
	} catch (error) {
		console.warn(`[her] injection ledger append failed: ${ledgerErrorMessage(error)}`);
	}

	return text;
}
