/**
 * G-146/G-148 dogfood — Her-owned deep-research Dynamic Workflow.
 * Plan → Research (parallel) → Verify (adversarial, parallel) → Synthesis.
 *
 * Agent: HER_DEER_AGENT=samantha|fake (default samantha).
 */

import { parallel, phase } from "../../../../../deer-workflow/src/flow/index.ts";
import { log } from "../../../../../deer-workflow/src/logging/index.ts";
import { bindAgent } from "../src/her-core/deer-agent-types.ts";
import { createDeerAgentFromEnv } from "../src/her-core/deer-samantha-agent.ts";

export const meta = {
	name: "her-deep-research",
	description:
		"Parallel angles, light adversarial verify, then synthesize a short sourced brief.",
	phases: [
		{ title: "Plan" },
		{ title: "Research" },
		{ title: "Verify" },
		{ title: "Synthesis" },
	],
	exampleArgs: {
		question: "How should Samantha use Dynamic Workflows?",
		maxAngles: 2,
	},
};

export interface DeepResearchInput {
	question: string;
	angles?: string[];
	/** Cap fan-out width (default 2, max 3). */
	maxAngles?: number;
}

export interface DeepResearchOutput {
	question: string;
	angles: string[];
	findings: string[];
	verdicts: string[];
	report: string;
}

const agent = bindAgent(createDeerAgentFromEnv());

const findingSchema = {
	type: "object",
	properties: {
		summary: { type: "string" },
		sources: { type: "array", items: { type: "string" } },
	},
	required: ["summary", "sources"],
	additionalProperties: false,
} as const;

const verdictSchema = {
	type: "object",
	properties: {
		keep: { type: "boolean" },
		issues: { type: "array", items: { type: "string" } },
		note: { type: "string" },
	},
	required: ["keep", "issues", "note"],
	additionalProperties: false,
} as const;

function clampMaxAngles(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 2;
	return Math.min(3, Math.max(2, n));
}

export default async function deepResearch(args: DeepResearchInput): Promise<DeepResearchOutput> {
	const question = args.question?.trim();
	if (!question) throw new Error("her-deep-research: question is required");
	const maxAngles = clampMaxAngles(args.maxAngles);

	phase("Plan");
	const angles =
		args.angles && args.angles.length > 0
			? args.angles
			: await agent<string[]>(
					`List ${maxAngles} independent research angles for this question as a JSON string array only.\nQuestion: ${question}`,
					{
						schema: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: maxAngles,
						} as unknown as { [key: string]: unknown },
					},
				).catch(async () => {
					const text = await agent(
						`List exactly ${maxAngles} short research angles for: ${question}. One per line, no numbering.`,
						{ sandbox: "read-only" },
					);
					return text
						.split(/\r?\n/)
						.map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
						.filter(Boolean)
						.slice(0, maxAngles);
				});

	const normalizedAngles = (Array.isArray(angles) ? angles : [String(angles)])
		.map((a) => String(a).trim())
		.filter(Boolean)
		.slice(0, maxAngles);
	while (normalizedAngles.length < 2) {
		normalizedAngles.push(
			normalizedAngles.length === 0
				? "Counter-evidence and risks"
				: "Practical implications for Her/Samantha",
		);
	}
	log(`## Plan\n- question: **${question}**\n- angles: ${normalizedAngles.length}`);

	phase("Research");
	const findings = await parallel(
		normalizedAngles.map(
			(angle) => () =>
				agent<{ summary: string; sources: string[] }>(
					`Research this angle for the question. Be concise. Do not write to any memory store.\nQuestion: ${question}\nAngle: ${angle}`,
					{ sandbox: "read-only", schema: findingSchema as unknown as { [key: string]: unknown } },
				)
					.then((r) => `### ${angle}\n${r.summary}\nSources: ${(r.sources ?? []).join("; ")}`)
					.catch(async () => {
						const text = await agent(
							`Research angle "${angle}" for: ${question}. 2 short paragraphs + source URLs if known. Do not write memory.`,
							{ sandbox: "read-only" },
						);
						return `### ${angle}\n${text}`;
					}),
		),
	);
	const completed = findings.filter((f): f is string => typeof f === "string" && f.length > 0);

	phase("Verify");
	const verdicts = await parallel(
		completed.map(
			(finding) => () =>
				agent<{ keep: boolean; issues: string[]; note: string }>(
					[
						"You are an independent skeptic. Try to REFUTE this finding.",
						"Check: overclaim, missing sources, confusion of one anecdote with a stable fact.",
						`Question: ${question}`,
						"Finding:",
						finding,
						"Return JSON: keep (true if still usable after skepticism), issues[], note.",
					].join("\n"),
					{ sandbox: "read-only", schema: verdictSchema as unknown as { [key: string]: unknown } },
				)
					.then((v) => {
						const issues = (v.issues ?? []).join("; ") || "(none)";
						return `keep=${v.keep} · ${v.note ?? ""} · issues: ${issues}`;
					})
					.catch(async () => {
						const text = await agent(
							`Skeptic review (refute if possible) of this finding for "${question}":\n${finding}\nReply with KEEP or DROP and one sentence why.`,
							{ sandbox: "read-only" },
						);
						return text;
					}),
		),
	);
	const verdictLines = verdicts.filter((v): v is string => typeof v === "string" && v.length > 0);
	log(`## Verify\n- verdicts: ${verdictLines.length}`);

	phase("Synthesis");
	const report = await agent(
		[
			"Synthesize a short markdown brief (≤400 words) for Fei.",
			"Prefer claims that survived skepticism; mark weak claims explicitly.",
			`Question: ${question}`,
			"",
			"Findings:",
			completed.join("\n\n"),
			"",
			"Verifier notes:",
			verdictLines.join("\n"),
		].join("\n"),
		{ sandbox: "read-only" },
	);

	return {
		question,
		angles: normalizedAngles,
		findings: completed,
		verdicts: verdictLines,
		report: typeof report === "string" ? report : JSON.stringify(report),
	};
}
