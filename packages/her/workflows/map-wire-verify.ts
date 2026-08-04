/**
 * G-149 — Map → Wire → Verify coding Dynamic Workflow
 * (multi-model-sop「大活的形状」encoded in TypeScript, not prose).
 *
 * Map: parallel read-only scouts (no full-file slurping).
 * Wire: single writer produces a concrete change plan (parent applies / or Wire cwd worktree).
 * Verify: parallel gate (command report) + adversarial diff review.
 *
 * Agent: HER_DEER_AGENT=samantha|fake (default samantha).
 */

import { parallel, phase } from "../../../../../deer-workflow/src/flow/index.ts";
import { log } from "../../../../../deer-workflow/src/logging/index.ts";
import { bindAgent } from "../src/her-core/deer-agent-types.ts";
import { createDeerAgentFromEnv } from "../src/her-core/deer-samantha-agent.ts";
import {
	allVerified,
	applyVerifierDecision,
	emptyProgressState,
	formatProgressCheckpoint,
	type ProgressState,
	withRequirements,
} from "../src/her-core/progress-state.ts";


export const meta = {
	name: "her-map-wire-verify",
	description:
		"Large coding jobs: parallel Map scouts → single Wire plan → Verify (gate + adversarial).",
	phases: [{ title: "Map" }, { title: "Wire" }, { title: "Verify" }],
	exampleArgs: {
		objective: "Add Workflow noun for kind=workflow in Tasks status line",
		lanes: ["task-dispatch status copy", "tasks-merge executor mapping"],
		maxLanes: 2,
		verifyHint: "npx tsx --test src/lib/task-dispatch.test.ts",
	},
};

export interface MapWireVerifyInput {
	/** Human objective for the coding change. */
	objective: string;
	/** Parallel Map focuses (default derived / capped). */
	lanes?: string[];
	/** Cap Map width (default 2, max 3). */
	maxLanes?: number;
	/** Optional repo/worktree hint for agents (read-only Map; Wire may use as cwd context). */
	cwd?: string;
	/** Hint for the gate verifier (command string; agent reports exitCode+tail). */
	verifyHint?: string;
}

export interface MapWireVerifyOutput {
	objective: string;
	lanes: string[];
	mapNotes: string[];
	wirePlan: string;
	gate: string;
	review: string;
	report: string;
	/** G-160 — verifier-committed progress; actor phases do not auto-verify. */
	progress: ProgressState;
	progressOk: boolean;
	progressCheckpoint: string;
}

const agent = bindAgent(createDeerAgentFromEnv());

const scoutSchema = {
	type: "object",
	properties: {
		hits: {
			type: "array",
			items: {
				type: "object",
				properties: {
					file: { type: "string" },
					line: { type: "number" },
					snippet: { type: "string" },
					suggestion: { type: "string" },
				},
				required: ["file", "line", "snippet", "suggestion"],
			},
		},
	},
	required: ["hits"],
	additionalProperties: false,
} as const;

const wireSchema = {
	type: "object",
	properties: {
		planMarkdown: { type: "string" },
		files: { type: "array", items: { type: "string" } },
		notes: { type: "string" },
	},
	required: ["planMarkdown", "files", "notes"],
	additionalProperties: false,
} as const;

const gateSchema = {
	type: "object",
	properties: {
		exitCode: { type: "number" },
		tail: { type: "string" },
	},
	required: ["exitCode", "tail"],
	additionalProperties: false,
} as const;

const reviewSchema = {
	type: "object",
	properties: {
		keep: { type: "boolean" },
		issues: { type: "array", items: { type: "string" } },
		note: { type: "string" },
	},
	required: ["keep", "issues", "note"],
	additionalProperties: false,
} as const;

function clampMaxLanes(raw: number | undefined): number {
	const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 2;
	return Math.min(3, Math.max(2, n));
}

function formatHits(
	lane: string,
	hits: Array<{ file: string; line: number; snippet: string; suggestion: string }>,
): string {
	const body = hits
		.map(
			(h) =>
				`- \`${h.file}:${h.line}\`\n  snippet: ${h.snippet}\n  suggestion: ${h.suggestion}`,
		)
		.join("\n");
	return `### Map · ${lane}\n${body || "(no hits)"}`;
}

export default async function mapWireVerify(args: MapWireVerifyInput): Promise<MapWireVerifyOutput> {
	const objective = args.objective?.trim();
	if (!objective) throw new Error("her-map-wire-verify: objective is required");
	const maxLanes = clampMaxLanes(args.maxLanes);
	const cwdHint = args.cwd?.trim() || "(caller cwd / Studio workspace)";
	const verifyHint = args.verifyHint?.trim() || "run the relevant unit tests for the touched files";
	let progress = withRequirements(emptyProgressState(), [
		{ id: "map", check: "Map notes non-empty" },
		{ id: "wire", check: "Wire plan produced" },
		{ id: "verify", check: "Gate exit 0 and adversarial keep=true" },
	]);

	phase("Map");
	const lanes =
		args.lanes && args.lanes.length > 0
			? args.lanes.map((l) => String(l).trim()).filter(Boolean).slice(0, maxLanes)
			: await agent<string[]>(
					`Split this coding objective into ${maxLanes} independent Map scout lanes (JSON string array only). Each lane is a precise Grep/search focus — not a full-file read.\nObjective: ${objective}`,
					{
						schema: {
							type: "array",
							items: { type: "string" },
							minItems: 2,
							maxItems: maxLanes,
						} as unknown as { [key: string]: unknown },
					},
				).catch(async () => {
					const text = await agent(
						`List exactly ${maxLanes} short Map scout focuses for: ${objective}. One per line.`,
						{ sandbox: "read-only" },
					);
					return text
						.split(/\r?\n/)
						.map((l) => l.replace(/^[-*\d.)\s]+/, "").trim())
						.filter(Boolean)
						.slice(0, maxLanes);
				});

	const normalizedLanes = (Array.isArray(lanes) ? lanes : [String(lanes)])
		.map((a) => String(a).trim())
		.filter(Boolean)
		.slice(0, maxLanes);
	while (normalizedLanes.length < 2) {
		normalizedLanes.push(
			normalizedLanes.length === 0 ? "Locate call sites and types" : "Locate tests and UI copy",
		);
	}
	log(`## Map\n- objective: **${objective}**\n- lanes: ${normalizedLanes.length}\n- cwd: ${cwdHint}`);

	const mapNotes = await parallel(
		normalizedLanes.map(
			(lane) => () =>
				agent<{
					hits: Array<{ file: string; line: number; snippet: string; suggestion: string }>;
				}>(
					[
						"You are a Map scout. READ-ONLY. Forbidden: full-file reads, edits, memory writes.",
						"Use Grep/search; return only hit windows (file:line + short snippet + concrete edit suggestion).",
						`Objective: ${objective}`,
						`Lane focus: ${lane}`,
						`Repo hint: ${cwdHint}`,
					].join("\n"),
					{ sandbox: "read-only", schema: scoutSchema as unknown as { [key: string]: unknown } },
				)
					.then((r) => formatHits(lane, Array.isArray(r.hits) ? r.hits : []))
					.catch(async () => {
						const text = await agent(
							`Map scout (read-only) for lane "${lane}" / objective: ${objective}. List file:line hits + suggestions. No edits.`,
							{ sandbox: "read-only" },
						);
						return `### Map · ${lane}\n${text}`;
					}),
		),
	);
	const mapCompleted = mapNotes.filter((n): n is string => typeof n === "string" && n.length > 0);
	if (mapCompleted.length > 0) {
		progress = applyVerifierDecision(progress, {
			action: "verify",
			requirementIds: ["map"],
			evidence: {
				kind: "artifact",
				summary: `${mapCompleted.length} map lane note(s)`,
			},
			values: [{ key: "mapLanes", value: String(mapCompleted.length), fromRequirement: "map" }],
		});
	}

	phase("Wire");
	const wire = await agent<{ planMarkdown: string; files: string[]; notes: string }>(
		[
			"You are the single Wire author. Produce ONE concrete change plan from the Map hits.",
			"Do NOT open a second writer. Prefer a patch-ready plan (files + ordered steps + key snippets).",
			"Do not write her-memory. Do not claim tests passed.",
			`Objective: ${objective}`,
			`Repo hint: ${cwdHint}`,
			"",
			"Map notes:",
			mapCompleted.join("\n\n"),
		].join("\n"),
		{ schema: wireSchema as unknown as { [key: string]: unknown } },
	).catch(async () => {
		const text = await agent(
			[
				"Single Wire plan from Map notes. Markdown. List files then steps.",
				`Objective: ${objective}`,
				mapCompleted.join("\n\n"),
			].join("\n"),
		);
		return { planMarkdown: text, files: [], notes: "unstructured wire fallback" };
	});
	const wirePlan =
		typeof wire.planMarkdown === "string" && wire.planMarkdown.trim()
			? wire.planMarkdown
			: JSON.stringify(wire);
	log(
		`## Wire\n- files: ${(wire.files ?? []).join(", ") || "(unlisted)"}\n- notes: ${wire.notes ?? ""}`,
	);
	if (wirePlan.trim()) {
		progress = applyVerifierDecision(progress, {
			action: "verify",
			requirementIds: ["wire"],
			evidence: {
				kind: "artifact",
				summary: `wire plan ${wirePlan.length} chars`,
			},
			values: [
				{
					key: "wireFiles",
					value: (wire.files ?? []).join(",") || "(unlisted)",
					fromRequirement: "wire",
				},
			],
		});
	}

	phase("Verify");
	const [gateRaw, reviewRaw] = await parallel([
		() =>
			agent<{ exitCode: number; tail: string }>(
				[
					"Gate lane: run (or honestly simulate only if you cannot execute) the verification command.",
					"Return real exitCode when you ran it; never invent green.",
					`verifyHint: ${verifyHint}`,
					`Objective: ${objective}`,
					"Touched plan:",
					wirePlan.slice(0, 4000),
				].join("\n"),
				{ schema: gateSchema as unknown as { [key: string]: unknown } },
			)
				.then((g) => `exitCode=${g.exitCode}\n${g.tail ?? ""}`)
				.catch(async () => {
					const text = await agent(
						`Report gate result for: ${verifyHint}. Include exit code if known.\nPlan:\n${wirePlan.slice(0, 2000)}`,
					);
					return text;
				}),
		() =>
			agent<{ keep: boolean; issues: string[]; note: string }>(
				[
					"Adversarial reviewer. Do NOT trust the Wire author's self-report.",
					"Hunt: missed call sites, wrong types, UI copy drift, tests not covering the change.",
					`Objective: ${objective}`,
					"Map:",
					mapCompleted.join("\n\n"),
					"Wire plan:",
					wirePlan.slice(0, 4000),
				].join("\n"),
				{ sandbox: "read-only", schema: reviewSchema as unknown as { [key: string]: unknown } },
			)
				.then((v) => {
					const issues = (v.issues ?? []).join("; ") || "(none)";
					return `keep=${v.keep} · ${v.note ?? ""} · issues: ${issues}`;
				})
				.catch(async () => {
					const text = await agent(
						`Adversarial review of Wire plan for "${objective}". KEEP or DROP + issues.\n${wirePlan.slice(0, 2000)}`,
						{ sandbox: "read-only" },
					);
					return text;
				}),
	]);
	const gate = typeof gateRaw === "string" ? gateRaw : String(gateRaw);
	const review = typeof reviewRaw === "string" ? reviewRaw : String(reviewRaw);
	log(`## Verify\n- gate: ${gate.split("\n")[0] ?? ""}\n- review: ${review.slice(0, 120)}`);
	const gateExit = (() => {
		const m = /exitCode\s*=\s*(-?\d+)/i.exec(gate);
		return m ? Number.parseInt(m[1], 10) : NaN;
	})();
	const reviewKeep = /\bkeep\s*=\s*true\b/i.test(review);
	if (gateExit === 0 && reviewKeep) {
		progress = applyVerifierDecision(progress, {
			action: "verify",
			requirementIds: ["verify"],
			evidence: {
				kind: "gate+review",
				summary: `exitCode=0 keep=true · ${review.slice(0, 160)}`,
			},
		});
	} else {
		progress = applyVerifierDecision(progress, {
			action: "invalidate",
			requirementIds: ["verify"],
			evidence: {
				kind: "gate+review",
				summary: `gateExit=${Number.isFinite(gateExit) ? gateExit : "unknown"} keep=${reviewKeep} · ${gate.split("\n")[0] ?? ""}`,
			},
		});
	}
	const progressOk = allVerified(progress);
	const progressCheckpoint = formatProgressCheckpoint(progress);
	log(progressCheckpoint);

	const report = [
		`# Map→Wire→Verify · ${objective}`,
		"",
		"## Map",
		...mapCompleted,
		"",
		"## Wire",
		wirePlan,
		"",
		"## Verify · Gate",
		gate,
		"",
		"## Verify · Review",
		review,
		"",
		"_Parent session applies the Wire plan (or re-runs Wire against a worktree). Do not treat this report as her-memory truth until published._",
		"",
		progressCheckpoint,
		"",
		`_progressOk=${progressOk}_`,
	].join("\n");

	return {
		objective,
		lanes: normalizedLanes,
		mapNotes: mapCompleted,
		wirePlan,
		gate,
		review,
		report,
		progress,
		progressOk,
		progressCheckpoint,
	};
}
