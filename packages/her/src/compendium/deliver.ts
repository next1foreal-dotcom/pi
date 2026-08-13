import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PublishConfig } from "../her-core/bg-task-config.ts";
import { herPublish, type PublishResult } from "../her-core/her-publish.ts";
import { Memory } from "../her-core/memory.ts";
import type { ClaimLedgerEntry, WorldNoteData } from "../her-core/memory-types.ts";
import { SYNTHESIS_SECTIONS } from "./prompts-synth.ts";
import type { Citation, SynthesisDoc, VerdictLevel } from "./types.ts";

const VERDICT_LABEL: Record<VerdictLevel, string> = {
	verified: "Verified",
	partial: "Partially verified",
	unverifiable: "Unverifiable",
	misattributed: "Misattributed",
	retracted: "Retracted / disputed",
};

export function renderSynthesisMarkdown(doc: SynthesisDoc): string {
	return [
		`# ${doc.title}`,
		"",
		`## ${SYNTHESIS_SECTIONS.timeline}`,
		"",
		renderList(doc.timeline.map((entry) => `${entry.date} — ${entry.fact} ${formatCitation(entry.citation)}`)),
		"",
		`## ${SYNTHESIS_SECTIONS.disagreements}`,
		"",
		renderDisagreementMarkdown(doc),
		"",
		`## ${SYNTHESIS_SECTIONS.quotes}`,
		"",
		renderQuotesMarkdown(doc),
		"",
		`## ${SYNTHESIS_SECTIONS.decisions}`,
		"",
		renderDecisionsMarkdown(doc),
		"",
	].join("\n");
}

export function renderSynthesisHtml(doc: SynthesisDoc): string {
	return [
		`<article>`,
		`<h1>${escapeHtml(doc.title)}</h1>`,
		`<section>`,
		`<h2>${escapeHtml(SYNTHESIS_SECTIONS.timeline)}</h2>`,
		"<ul>",
		...doc.timeline.map(
			(entry) =>
				`<li>${escapeHtml(entry.date)} — ${escapeHtml(entry.fact)} ${formatCitationHtml(entry.citation)}</li>`,
		),
		"</ul>",
		`</section>`,
		`<section>`,
		`<h2>${escapeHtml(SYNTHESIS_SECTIONS.disagreements)}</h2>`,
		...doc.disagreements.flatMap((entry) => [
			`<h3>${escapeHtml(entry.topic)}</h3>`,
			`<p>Verdict: ${escapeHtml(VERDICT_LABEL[entry.verdict])}</p>`,
			"<ul>",
			...entry.claims.map((claim) => `<li>${escapeHtml(claim.claim)} ${formatCitationHtml(claim.citation)}</li>`),
			"</ul>",
		]),
		`</section>`,
		`<section>`,
		`<h2>${escapeHtml(SYNTHESIS_SECTIONS.quotes)}</h2>`,
		...doc.quotes.map(
			(entry) => `<blockquote><p>${escapeHtml(entry.text)}</p>${formatCitationHtml(entry.citation)}</blockquote>`,
		),
		`</section>`,
		`<section>`,
		`<h2>${escapeHtml(SYNTHESIS_SECTIONS.decisions)}</h2>`,
		...doc.decisions.flatMap((entry) => [
			`<h3>${escapeHtml(entry.question)}</h3>`,
			"<ul>",
			...entry.options.map((option) => `<li>${escapeHtml(option.label)} — cost: ${escapeHtml(option.cost)}</li>`),
			"</ul>",
		]),
		`</section>`,
		`</article>`,
		"",
	].join("\n");
}

function renderDisagreementMarkdown(doc: SynthesisDoc): string {
	if (!doc.disagreements.length) return "_None._";
	return doc.disagreements
		.map((entry) => {
			const claims = entry.claims.map((claim) => `- ${claim.claim} ${formatCitation(claim.citation)}`).join("\n");
			return `### ${entry.topic}\n\nVerdict: ${VERDICT_LABEL[entry.verdict]}\n\n${claims}`;
		})
		.join("\n\n");
}

function renderQuotesMarkdown(doc: SynthesisDoc): string {
	if (!doc.quotes.length) return "_None._";
	return doc.quotes.map((entry) => `> ${entry.text}\n>\n> ${formatCitation(entry.citation)}`).join("\n\n");
}

function renderDecisionsMarkdown(doc: SynthesisDoc): string {
	if (!doc.decisions.length) return "_None._";
	return doc.decisions
		.map((entry) => {
			const options = entry.options.map((option) => `- ${option.label} — cost: ${option.cost}`).join("\n");
			return `### ${entry.question}\n\n${options}`;
		})
		.join("\n\n");
}

function renderList(items: string[]): string {
	return items.length ? items.map((item) => `- ${item}`).join("\n") : "_None._";
}

function formatCitation(citation: Citation): string {
	const locator = citation.locator ? `, ${citation.locator}` : "";
	return `[Source: ${citation.sourceId}${locator}](${citation.href})`;
}

function formatCitationHtml(citation: Citation): string {
	const locator = citation.locator ? `, ${citation.locator}` : "";
	return `<a href="${escapeHtml(citation.href)}">[Source: ${escapeHtml(citation.sourceId)}${escapeHtml(locator)}]</a>`;
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PUBLISH_SLUG = /^[a-z0-9-]{1,64}$/;

export type DeliverSynthesisInput = {
	doc: SynthesisDoc;
	memoryRoot: string;
	sourceUrl?: string;
	publish?: PublishConfig;
};

export type DeliverSynthesisResult = {
	worldNoteId: string;
	published: PublishResult;
};

export async function deliverSynthesis(input: DeliverSynthesisInput): Promise<DeliverSynthesisResult> {
	const slug = input.doc.slug.trim();
	if (!PUBLISH_SLUG.test(slug)) throw new Error(`invalid publish slug: ${slug}`);
	const markdown = renderSynthesisMarkdown(input.doc);
	const html = renderSynthesisHtml(input.doc);
	const sourceUrl = input.sourceUrl?.trim() || `compendium:${slug}`;
	const memory = new Memory(input.memoryRoot);
	const worldNoteId = await memory.writeWorldNote(worldNoteFromDoc(input.doc, markdown, sourceUrl));
	const stagingDir = join(input.memoryRoot, ".her", "compendium", slug);
	await mkdir(stagingDir, { recursive: true });
	const stagingPath = join(stagingDir, "briefing.html");
	await writeFile(stagingPath, html, "utf8");
	const published = await herPublish(input.memoryRoot, {
		filePath: stagingPath,
		title: input.doc.title,
		description: `Compendium briefing ${slug}`,
		slug,
		...(input.publish ? { publish: input.publish } : {}),
	});
	return { worldNoteId, published };
}

function worldNoteFromDoc(doc: SynthesisDoc, markdown: string, sourceUrl: string): WorldNoteData {
	return {
		title: doc.title,
		sourceUrl,
		sourceType: "compendium",
		contentHash: createHash("sha256").update(`${sourceUrl}\n${markdown}`).digest("hex"),
		memoryStatus: "active",
		extracted: markdown,
		coverage: `Synthesized ${doc.timeline.length} timeline facts, ${doc.disagreements.length} disagreements, ${doc.quotes.length} quotes, ${doc.decisions.length} decisions.`,
		claims: claimsFromDoc(doc),
		read: readFromDoc(doc),
		steal: doc.quotes.map((entry) => entry.text),
		connections: [],
		take: doc.decisions[0]?.question ?? doc.title,
		possibleMoves: doc.decisions.map((entry) => entry.question),
		provenance: "world-ingested",
	};
}

function claimsFromDoc(doc: SynthesisDoc): ClaimLedgerEntry[] {
	return doc.disagreements.flatMap((entry) =>
		entry.claims.map((claim) => ({
			claim: claim.claim,
			verdict: claimVerdict(entry.verdict),
			evidence: `${claim.citation.sourceId} ${claim.citation.locator} ${claim.citation.href}`.trim(),
			sourceQuality: "primary" as const,
		})),
	);
}

function claimVerdict(verdict: VerdictLevel): ClaimLedgerEntry["verdict"] {
	if (verdict === "verified") return "supported";
	if (verdict === "retracted" || verdict === "misattributed") return "contradicted";
	return "insufficient_evidence";
}

function readFromDoc(doc: SynthesisDoc): string {
	if (!doc.disagreements.length) return `Cited synthesis of ${doc.title}.`;
	return doc.disagreements.map((entry) => `${entry.topic}: ${VERDICT_LABEL[entry.verdict]}`).join(" ");
}
