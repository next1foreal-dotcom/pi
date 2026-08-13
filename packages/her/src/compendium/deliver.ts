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
