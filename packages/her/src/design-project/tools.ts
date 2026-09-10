import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SAMANTHA_REPO_ROOT } from "../her-core/channel-probe-gate.ts";
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
import {
	DEFAULT_VERSION_LIMIT,
	type GitRun,
	listVersions,
	restoreDesign,
	stillPath,
	uncommittedFiles,
} from "../her-core/design-version.ts";

export interface DesignProjectToolDeps {
	/** Override the on-disk projects directory (tests). Defaults to <repo>/design/projects. */
	projectsDir?: string;
	/** Override the repo the versions come from (tests). Defaults to the samantha checkout. */
	repoRoot?: string;
	/** Override how git is run (tests). Defaults to the real thing. */
	gitRun?: GitRun;
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
	const repoRoot = deps.repoRoot ?? SAMANTHA_REPO_ROOT;
	const gitOpts = deps.gitRun ? { run: deps.gitRun } : {};

	/**
	 * The design's newest commit, for stamping onto a round as it is logged.
	 *
	 * Best effort on purpose: a design that has never been committed, a
	 * checkout with no git, a repo that is busy — none of those should stop a
	 * round being recorded. A round with no version pointer is worth strictly
	 * more than no round at all, and the field is optional for exactly this.
	 */
	async function versionNow(slug: string): Promise<{ commit?: string; still?: string }> {
		try {
			const [newest] = await listVersions(slug, repoRoot, { limit: 1, ...gitOpts });
			return newest ? { commit: newest.commit, still: stillPath(slug) } : {};
		} catch {
			return {};
		}
	}

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
			"(the tool stamps the time) — the only sanctioned way to log a round; never hand-edit the manifest. " +
			'At code, the last stage, calling again with stage "code" and an artifact or a note writes that step\'s own ' +
			"receipt — every earlier step gets one on the way out, and the last one has no way out. Once: a second " +
			"call is refused rather than rewriting the receipt.",
		parameters: Type.Object({
			slug: Type.String(),
			stage: StringEnum(DESIGN_STAGES),
			artifact: Type.Optional(Type.String({ description: "Reference to the departing stage's artifact." })),
			note: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params) {
			try {
				// A round at "iterations" IS a version, so it is stamped with one.
				// Every other call is a stage move and gets no pointer: the thing
				// that changed there was the process, not the design.
				const logging = params.stage === "iterations" && Boolean(params.note?.trim());
				const version = logging ? await versionNow(params.slug) : {};
				const manifest = await setStage(
					params.slug,
					params.stage,
					{
						...(params.artifact ? { artifact: params.artifact } : {}),
						...(params.note ? { note: params.note } : {}),
						...version,
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
		name: "design_version_history",
		label: "Design Version History",
		description:
			"Every version of ONE design, newest first. A version is a COMMIT that touched it — nothing is copied " +
			"anywhere; the bytes have always been in git and this reads their history. A design is two paths: " +
			"packages/design-lab/src/screens/<slug> and design/projects/<slug>. The manifest is deliberately not one " +
			"of them, so restoring a version never erases the record of the restore. " +
			"Each entry has the sha, the commit subject, the author date, the files it touched, and the display name " +
			"someone gave it with design_version_name (null for the many that have none). " +
			"Also reports edits under those paths that no version holds yet — that is what a restore would overwrite, " +
			"and the only part of it git cannot give back. " +
			"Sibling tools: design_version_list is the same names across the WHOLE repo rather than one design, and " +
			"design_version_restore puts one of these back. Read-only.",
		parameters: Type.Object({
			slug: Type.String({ description: "The design's slug, e.g. loora-landing." }),
			limit: Type.Optional(
				Type.Number({ description: `How many versions to return. Default ${DEFAULT_VERSION_LIMIT}, max 200.` }),
			),
		}),
		async execute(_toolCallId, params) {
			try {
				const versions = await listVersions(params.slug, repoRoot, {
					...(params.limit ? { limit: params.limit } : {}),
					...gitOpts,
				});
				const dirty = await uncommittedFiles(params.slug, repoRoot, gitOpts);
				const head = versions[0];
				const lines = versions.map(
					(v) =>
						`${v.name ? "* " : "  "}${v.commit.slice(0, 9)}  ${v.at.slice(0, 16).replace("T", " ")}  ` +
						`${v.name ? `${v.name} — ` : ""}${v.subject}`,
				);
				const text = versions.length
					? `${versions.length} version(s) of "${params.slug}", newest first:\n${lines.join("\n")}` +
						(dirty.length ? `\n\nUncommitted under this design (${dirty.length}): ${dirty.join(", ")}` : "")
					: `No versions of "${params.slug}" yet — nothing under its paths has been committed.`;
				return textResult(text, { ok: true, versions, dirty, head: head?.commit ?? null });
			} catch (error) {
				return fail(error);
			}
		},
	});

	pi.registerTool({
		name: "design_version_restore",
		label: "Design Version Restore",
		description:
			"Put a version's bytes back into the working tree: git checkout <commit> -- <the design's paths>. " +
			"NOTHING IS COMMITTED, no history is rewritten, and HEAD DOES NOT MOVE — the restore lands as ordinary " +
			"working-tree edits, to be looked at, kept, or thrown away like any others. That last part is why this " +
			"tool exists where design_version_list refuses to restore: switching HEAD changes the whole repo out from " +
			"under every other session in it, and checking out one path changes one design. " +
			"Dry run by default: without apply:true it only reports which files WOULD change, which is the cheap way " +
			"to answer 'which version was it again?'. With apply:true it writes them. " +
			"Uncommitted work under the design's paths is overwritten and cannot be recovered, so it is listed in the " +
			"dry run first. The project manifest is never touched.",
		parameters: Type.Object({
			slug: Type.String(),
			commit: Type.String({ description: "A git sha, 7 to 40 hex characters, from design_versions." }),
			apply: Type.Optional(Type.Boolean({ description: "Write the files. Omitted or false = report only." })),
		}),
		async execute(_toolCallId, params) {
			try {
				const dirty = await uncommittedFiles(params.slug, repoRoot, gitOpts);
				const plan = await restoreDesign(params.slug, params.commit, repoRoot, {
					...(params.apply ? { apply: true } : {}),
					...gitOpts,
				});
				if (plan.files.length === 0) {
					return textResult(
						`"${params.slug}" already matches ${params.commit.slice(0, 9)} — nothing to restore.`,
						{ ok: true, ...plan, dirty },
					);
				}
				const list = plan.files.join("\n");
				const text = plan.applied
					? `Restored "${params.slug}" to ${params.commit.slice(0, 9)}. ${plan.files.length} file(s) written:\n${list}\n\nNothing was committed — review and commit, or git restore to undo.`
					: `Dry run. Restoring "${params.slug}" to ${params.commit.slice(0, 9)} would change ${plan.files.length} file(s):\n${list}` +
						(dirty.length
							? `\n\nUncommitted work that would be LOST (${dirty.length}): ${dirty.join(", ")}`
							: "") +
						"\n\nCall again with apply:true to write them.";
				return textResult(text, { ok: true, ...plan, dirty });
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
