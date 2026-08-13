import { completeJson, JsonTruncatedError } from "../her-core/memory-utils.ts";
import type { ModelLike } from "../her-core/model.ts";
import { resolveCitation } from "./citation.ts";
import { createSynthesisPrompt } from "./prompts-synth.ts";
import type {
	ChapterAnalysis,
	Citation,
	DecisionPoint,
	DisagreementClaim,
	DisagreementEntry,
	DroppedCitation,
	QuoteEntry,
	SynthesisDoc,
	SynthManifest,
	TimelineEntry,
	VerdictLevel,
} from "./types.ts";

const VERDICTS = new Set<VerdictLevel>(["verified", "partial", "unverifiable", "misattributed", "retracted"]);
const MAX_DECISIONS = 4;
const FLOOR_ANALYSES = 1;

export async function synthesize(
	manifest: SynthManifest,
	analyses: readonly ChapterAnalysis[],
	model: ModelLike,
): Promise<SynthesisDoc> {
	validateManifest(manifest);
	if (!analyses.length) throw new Error("at least one chapter analysis is required");
	let current = [...analyses];
	for (;;) {
		try {
			const raw = await completeJson<unknown>(() =>
				model.complete(createSynthesisPrompt({ sources: manifest.sources, analyses: current }), { strong: true }),
			);
			return assembleDoc(manifest, raw);
		} catch (error) {
			if (!(error instanceof JsonTruncatedError)) throw error;
			if (current.length <= FLOOR_ANALYSES) throw error;
			current = current.slice(0, Math.max(FLOOR_ANALYSES, Math.floor(current.length / 2)));
		}
	}
}

function validateManifest(manifest: SynthManifest): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.slug)) {
		throw new Error("manifest slug must be a safe filename segment");
	}
	if (!manifest.sources.length) throw new Error("at least one citation source is required");
	for (const source of manifest.sources) {
		if (!source.id.trim()) throw new Error("citation source id must not be blank");
		if (!source.sourceUrl.trim()) throw new Error(`citation source ${source.id} sourceUrl must not be blank`);
	}
}

function assembleDoc(manifest: SynthManifest, raw: unknown): SynthesisDoc {
	if (!isRecord(raw)) throw new Error("synthesis model returned a non-object");
	const droppedCitations: DroppedCitation[] = [];
	const cite = (sourceId: string, locator: string): Citation | null => {
		const resolved = resolveCitation(sourceId, locator, manifest.sources);
		if (resolved) return resolved;
		droppedCitations.push({ sourceId: sourceId.trim() || "(blank)", locator, reason: "unknown-source-id" });
		return null;
	};
	const title =
		typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : (manifest.title ?? manifest.slug);
	return {
		title,
		slug: manifest.slug,
		timeline: assembleTimeline(raw.timeline, cite),
		disagreements: assembleDisagreements(raw.disagreements, cite),
		quotes: assembleQuotes(raw.quotes, cite),
		decisions: assembleDecisions(raw.decisions),
		droppedCitations,
	};
}

function assembleTimeline(
	value: unknown,
	cite: (sourceId: string, locator: string) => Citation | null,
): TimelineEntry[] {
	const entries: TimelineEntry[] = [];
	for (const item of asRecords(value)) {
		const date = stringField(item, "date");
		const fact = stringField(item, "fact");
		const sourceId = stringField(item, "sourceId");
		if (!date || !fact || !sourceId) continue;
		const citation = cite(sourceId, stringField(item, "locator") ?? "");
		if (!citation) continue;
		entries.push({ date, fact, citation });
	}
	return entries.sort((left, right) => left.date.localeCompare(right.date));
}

function assembleDisagreements(
	value: unknown,
	cite: (sourceId: string, locator: string) => Citation | null,
): DisagreementEntry[] {
	const entries: DisagreementEntry[] = [];
	for (const item of asRecords(value)) {
		const topic = stringField(item, "topic");
		const verdict = stringField(item, "verdict");
		if (!topic || !verdict || !VERDICTS.has(verdict as VerdictLevel)) continue;
		const claims: DisagreementClaim[] = [];
		for (const claimItem of asRecords(item.claims)) {
			const sourceId = stringField(claimItem, "sourceId");
			const claim = stringField(claimItem, "claim");
			if (!sourceId || !claim) continue;
			const citation = cite(sourceId, stringField(claimItem, "locator") ?? "");
			if (!citation) continue;
			claims.push({ sourceId: citation.sourceId, claim, citation });
		}
		if (claims.length < 2) continue;
		const entry: DisagreementEntry = { topic, claims, verdict: verdict as VerdictLevel };
		const note = stringField(item, "note");
		if (note) entry.note = note;
		entries.push(entry);
	}
	return entries;
}

function assembleQuotes(value: unknown, cite: (sourceId: string, locator: string) => Citation | null): QuoteEntry[] {
	const entries: QuoteEntry[] = [];
	for (const item of asRecords(value)) {
		const text = stringField(item, "text");
		const sourceId = stringField(item, "sourceId");
		if (!text || !sourceId) continue;
		const citation = cite(sourceId, stringField(item, "locator") ?? "");
		if (!citation) continue;
		entries.push({ text, citation });
	}
	return entries;
}

function assembleDecisions(value: unknown): DecisionPoint[] {
	const entries: DecisionPoint[] = [];
	for (const item of asRecords(value)) {
		if (entries.length >= MAX_DECISIONS) break;
		const question = stringField(item, "question");
		if (!question) continue;
		const options = asRecords(item.options)
			.map((option) => {
				const label = stringField(option, "label");
				const cost = stringField(option, "cost");
				return label && cost ? { label, cost } : null;
			})
			.filter((option): option is { label: string; cost: string } => option !== null);
		if (!options.length) continue;
		entries.push({ question, options });
	}
	return entries;
}

function asRecords(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
