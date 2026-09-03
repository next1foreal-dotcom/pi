import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	auditProjects,
	createProject,
	DESIGN_STAGES,
	getProject,
	listProjects,
	projectsDirectory,
	recordGateVerdict,
	setStage,
} from "../her-core/design-project.ts";

export interface DesignProjectToolDeps {
	/** Override the on-disk projects directory (tests). Defaults to <repo>/design/projects. */
	projectsDir?: string;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fail(error: unknown) {
	return textResult(errorMessage(error), { ok: false });
}

export function registerDesignProjectTools(pi: ExtensionAPI, deps: DesignProjectToolDeps = {}): void {
	const dir = deps.projectsDir ? projectsDirectory(deps.projectsDir) : undefined;

	pi.registerTool({
		name: "design_project_create",
		label: "Design Project Create",
		description:
			"Create a design workshop project at design/projects/<slug>.project.json (repo root). Starts at stage idea. " +
			"Slug is lowercase letters, digits, and hyphens only — path traversal is refused. Fails if the slug already exists. " +
			"This writes a new manifest; it does not advance stages or record gates.",
		parameters: Type.Object({
			slug: Type.String({ description: "Lowercase letters, digits, hyphens. No slashes or uppercase." }),
			brief: Type.String({ description: "What this workshop is for." }),
		}),
		async execute(_toolCallId, params) {
			try {
				const manifest = await createProject(params.slug, params.brief, dir);
				return textResult(`Created design project "${manifest.slug}" at stage idea.`, { ok: true, manifest });
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_project_get",
		label: "Design Project Get",
		description:
			"Read one design workshop project manifest by slug (brief, stage, step artifacts, gates with evidence, iteration log). " +
			"Read-only — does not write files.",
		parameters: Type.Object({
			slug: Type.String(),
		}),
		async execute(_toolCallId, params) {
			try {
				const manifest = await getProject(params.slug, dir);
				if (!manifest) return textResult(`Design project "${params.slug}" not found.`, { ok: false });
				return textResult(`Design project "${manifest.slug}" is at stage ${manifest.stage}.`, {
					ok: true,
					manifest,
				});
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_project_list",
		label: "Design Project List",
		description:
			"List design workshop projects (slug, brief, stage, gate statuses). Read-only — does not write files.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const projects = await listProjects(dir);
				return textResult(
					projects.length === 0
						? "No design workshop projects."
						: `Design workshop projects (${projects.length}): ${projects.map((row) => `${row.slug}@${row.stage}`).join(", ")}.`,
					{ ok: true, projects },
				);
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_project_set_stage",
		label: "Design Project Set Stage",
		description:
			"Move a design workshop project one step forward, or back to any earlier stage. Writes design/projects/<slug>.project.json. " +
			"Entering draft is refused unless the wireframe hard gate is already approved — the reply names what is missing. " +
			"Entering code is refused unless the final hard gate is approved. Moodboard is a light gate: recorded on arrival, never blocks. " +
			"Skipping stages is refused. " +
			'At iterations, calling again with stage "iterations" and a note appends one round to the iteration log ' +
			"(the tool stamps the time) — the only sanctioned way to log a round; never hand-edit the manifest.",
		parameters: Type.Object({
			slug: Type.String(),
			stage: StringEnum(DESIGN_STAGES),
			artifact: Type.Optional(Type.String({ description: "Reference to the departing stage's artifact." })),
			note: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			try {
				const manifest = await setStage(
					params.slug,
					params.stage,
					{
						...(params.artifact ? { artifact: params.artifact } : {}),
						...(params.note ? { note: params.note } : {}),
					},
					dir,
				);
				return textResult(`Design project "${manifest.slug}" is now at stage ${manifest.stage}.`, {
					ok: true,
					manifest,
				});
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_project_gate",
		label: "Design Project Gate",
		description:
			"Record a gate verdict on a design workshop project and write the manifest. " +
			"approved and returned require non-empty evidence: Fei's own words or an annotation id (free text; the machine only checks non-empty and keeps the trail). " +
			"Empty or blank evidence is refused — no evidence, no gate. " +
			"Hard gates: wireframe (blocks draft) and final (blocks code). Light gate: moodboard (recorded, does not block). " +
			"returned on a hard gate retreats the project to that gate's stage.",
		parameters: Type.Object({
			slug: Type.String(),
			gate: StringEnum(["wireframe", "final", "moodboard"] as const),
			status: StringEnum(["approved", "returned"] as const),
			evidence: Type.Optional(
				Type.String({ description: "Fei's words or an annotation id. Required for approved/returned." }),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const manifest = await recordGateVerdict(
					params.slug,
					params.gate,
					params.status,
					params.evidence ?? "",
					dir,
				);
				return textResult(`Design project "${manifest.slug}" gate "${params.gate}" is ${params.status}.`, {
					ok: true,
					manifest,
				});
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_project_audit",
		label: "Design Project Audit",
		description:
			"Audit every design/projects/*.project.json. Reports red findings for approved gates with missing or blank evidence, " +
			"for a stage past a hard gate that is not approved, for hand-edited iteration records without a summary, " +
			"and for timestamps in the future. Read-only — does not write or repair files.",
		parameters: Type.Object({}),
		async execute() {
			try {
				const findings = await auditProjects(dir);
				const red = findings.length;
				return textResult(
					red === 0 ? "Design workshop audit: no red findings." : `Design workshop audit: ${red} red finding(s).`,
					{ ok: true, findings },
				);
			} catch (error) {
				return fail(error);
			}
		},
	});
}
