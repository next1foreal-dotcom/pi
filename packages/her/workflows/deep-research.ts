/**
 * G-146 dogfood — Her-owned deep-research Dynamic Workflow.
 * Run via deer-workflow (Bun) or her workers.deer brief.
 *
 * Agent selection: HER_DEER_AGENT=samantha|fake (default samantha).
 */

import { parallel, phase } from "../../../../../deer-workflow/src/flow/index.ts";
import { log } from "../../../../../deer-workflow/src/logging/index.ts";
import { bindAgent } from "../src/her-core/deer-agent-types.ts";
import { createDeerAgentFromEnv } from "../src/her-core/deer-samantha-agent.ts";

export const meta = {
	name: "her-deep-research",
	description: "Parallel angles then synthesize a short sourced brief (Her dogfood).",
	phases: [{ title: "Plan" }, { title: "Research" }, { title: "Synthesis" }],
	exampleArgs: {
		question: "How should Samantha use Dynamic Workflows?",
	},
};

export interface DeepResearchInput {
	question: string;
	angles?: string[];
}

export interface DeepResearchOutput {
	question: string;
	angles: string[];
	findings: string[];
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

export default async function deepResearch(args: DeepResearchInput): Promise<DeepResearchOutput> {
	const question = args.question?.trim();
	if (!question) throw new Error("her-deep-research: question is required");

	phase("Plan");
	const angles =
		args.angles && args.angles.length > 0
			? args.angles
			: await agent<string[]>(
					`List 2-3 independent research angles for this question as a JSON string array only.\nQuestion: ${question}`,
					{
						schema: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: 3,
						} as unknown as { [key: string]: unknown },
					},
				).catch(async () => {
					const text = await agent(
						`List exactly 2 short research angles for: ${question}. One per line, no numbering.`,
						{ sandbox: "read-only" },
					);
					return text
						.split(/\r?\n/)
						.map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
						.filter(Boolean)
						.slice(0, 3);
				});

	const normalizedAngles = (Array.isArray(angles) ? angles : [String(angles)])
		.map((a) => String(a).trim())
		.filter(Boolean)
		.slice(0, 3);
	if (normalizedAngles.length < 2) {
		normalizedAngles.push("Counter-evidence and risks", "Practical implications for Her/Samantha");
	}
	log(`## Plan\n- question: **${question}**\n- angles: ${normalizedAngles.length}`);

	phase("Research");
	const findings = await parallel(
		normalizedAngles.map(
			(angle) => () =>
				agent<{ summary: string; sources: string[] }>(
					`Research this angle for the question. Be concise.\nQuestion: ${question}\nAngle: ${angle}`,
					{ sandbox: "read-only", schema: findingSchema as unknown as { [key: string]: unknown } },
				)
					.then((r) => `### ${angle}\n${r.summary}\nSources: ${(r.sources ?? []).join("; ")}`)
					.catch(async () => {
						const text = await agent(
							`Research angle "${angle}" for: ${question}. 2 short paragraphs + source URLs if known.`,
							{ sandbox: "read-only" },
						);
						return `### ${angle}\n${text}`;
					}),
		),
	);
	const completed = findings.filter((f): f is string => typeof f === "string" && f.length > 0);

	phase("Synthesis");
	const report = await agent(
		`Synthesize a short markdown brief (≤400 words) for Fei.\nQuestion: ${question}\n\nFindings:\n${completed.join("\n\n")}`,
		{ sandbox: "read-only" },
	);

	return {
		question,
		angles: normalizedAngles,
		findings: completed,
		report: typeof report === "string" ? report : JSON.stringify(report),
	};
}
