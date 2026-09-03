/** Design workshop project manifests (G-375·3). Drop: design/projects/<slug>.project.json. */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SAMANTHA_REPO_ROOT } from "./channel-probe-gate.ts";
import { readText, writeJson } from "./store.ts";

export const DESIGN_STAGES = [
	"idea",
	"research",
	"moodboard",
	"wireframe",
	"draft",
	"iterations",
	"final",
	"code",
] as const;
export type DesignStage = (typeof DESIGN_STAGES)[number];

export type HardGateName = "wireframe" | "final";
export type LightGateName = "moodboard";
export type DesignGateName = HardGateName | LightGateName;
export type GateStatus = "pending" | "approved" | "returned" | "informed";
export type GateVerdictStatus = "approved" | "returned";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GATE_NAMES = ["wireframe", "final", "moodboard"] as const;

const HARD_GATES: Partial<Record<DesignStage, HardGateName>> = {
	draft: "wireframe",
	code: "final",
};

const PENDING_GATES: Partial<Record<DesignStage, HardGateName>> = {
	wireframe: "wireframe",
	final: "final",
};

const LIGHT_GATES: Partial<Record<DesignStage, LightGateName>> = {
	moodboard: "moodboard",
};

const GATE_RETURN_STAGE: Record<HardGateName, DesignStage> = {
	wireframe: "wireframe",
	final: "final",
};

const queues = new Map<string, Promise<void>>();

export interface GateRecord {
	status: GateStatus;
	evidence?: string;
	at: string;
}

export interface StepRecord {
	artifact?: string;
	note?: string;
	at: string;
}

export interface IterationRecord {
	summary: string;
	at: string;
}

export interface ProjectManifest {
	brief: string;
	createdAt: string;
	gates: {
		final?: GateRecord;
		moodboard?: GateRecord;
		wireframe?: GateRecord;
	};
	iterations: IterationRecord[];
	slug: string;
	stage: DesignStage;
	steps: Record<string, StepRecord>;
	updatedAt: string;
}

export interface ProjectSummary {
	brief: string;
	gates: Record<string, { status: string }>;
	slug: string;
	stage: DesignStage;
}

export interface AuditFinding {
	message: string;
	severity: "red";
	slug: string;
}

export function isValidProjectSlug(slug: string): boolean {
	return typeof slug === "string" && SLUG_RE.test(slug);
}

export function validateProjectSlug(slug: string): string {
	if (!isValidProjectSlug(slug)) {
		throw new Error(`Invalid slug "${slug}": use lowercase letters, digits, and hyphens only (no path separators)`);
	}
	return slug;
}

export function projectsDirectory(directory?: string): string {
	return resolve(directory ?? join(SAMANTHA_REPO_ROOT, "design", "projects"));
}

export function projectManifestPath(slug: string, directory?: string): string {
	validateProjectSlug(slug);
	return join(projectsDirectory(directory), `${slug}.project.json`);
}

function isStage(value: unknown): value is DesignStage {
	return typeof value === "string" && (DESIGN_STAGES as readonly string[]).includes(value);
}

function isHardGate(value: unknown): value is HardGateName {
	return value === "wireframe" || value === "final";
}

function isGateName(value: unknown): value is DesignGateName {
	return value === "wireframe" || value === "final" || value === "moodboard";
}

function stageIndex(stage: DesignStage): number {
	return DESIGN_STAGES.indexOf(stage);
}

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.then(task);
	queues.set(
		key,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}

async function readManifest(slug: string, directory?: string): Promise<ProjectManifest | null> {
	const text = await readText(projectManifestPath(slug, directory));
	if (!text) return null;
	try {
		const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as ProjectManifest;
	} catch {
		return null;
	}
}

async function writeManifest(slug: string, manifest: ProjectManifest, directory?: string): Promise<void> {
	await writeJson(projectManifestPath(slug, directory), manifest);
}

function nowIso(): string {
	return new Date().toISOString();
}

export async function createProject(slug: string, brief: string, directory?: string): Promise<ProjectManifest> {
	validateProjectSlug(slug);
	if (typeof brief !== "string" || !brief.trim()) {
		throw new Error("brief must be a non-empty string");
	}
	const root = projectsDirectory(directory);
	return enqueue(`${root}\0${slug}`, async () => {
		const existing = await readManifest(slug, root);
		if (existing) throw new Error(`Project "${slug}" already exists`);
		const at = nowIso();
		const manifest: ProjectManifest = {
			brief: brief.trim(),
			createdAt: at,
			gates: {},
			iterations: [],
			slug,
			stage: "idea",
			steps: {},
			updatedAt: at,
		};
		await writeManifest(slug, manifest, root);
		return manifest;
	});
}

export async function getProject(slug: string, directory?: string): Promise<ProjectManifest | null> {
	validateProjectSlug(slug);
	return readManifest(slug, directory);
}

export async function listProjects(directory?: string): Promise<ProjectSummary[]> {
	const root = projectsDirectory(directory);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const result: ProjectSummary[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".project.json")) continue;
		const entrySlug = entry.name.slice(0, -".project.json".length);
		if (!isValidProjectSlug(entrySlug)) continue;
		const manifest = await readManifest(entrySlug, root);
		if (!manifest) continue;
		const gates: Record<string, { status: string }> = {};
		for (const [key, gate] of Object.entries(manifest.gates)) {
			if (gate) gates[key] = { status: gate.status };
		}
		result.push({
			brief: manifest.brief,
			gates,
			slug: manifest.slug,
			stage: manifest.stage,
		});
	}
	return result.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function setStage(
	slug: string,
	stage: DesignStage,
	opts?: { artifact?: string; note?: string },
	directory?: string,
): Promise<ProjectManifest> {
	validateProjectSlug(slug);
	if (!isStage(stage)) throw new Error(`Invalid stage "${String(stage)}"`);
	const root = projectsDirectory(directory);
	return enqueue(`${root}\0${slug}`, async () => {
		const manifest = await readManifest(slug, root);
		if (!manifest) throw new Error(`Project "${slug}" does not exist`);
		if (!isStage(manifest.stage)) throw new Error(`Project "${slug}" has invalid stage "${String(manifest.stage)}"`);
		const currentIndex = stageIndex(manifest.stage);
		const targetIndex = stageIndex(stage);
		const at = nowIso();
		if (targetIndex === currentIndex) {
			// A round at "iterations" is logged by calling set_stage again with a note; no other stage is re-entered.
			if (stage === "iterations" && opts?.note && opts.note.trim() !== "") {
				manifest.iterations.push({ summary: opts.note, at });
				manifest.updatedAt = at;
				await writeManifest(slug, manifest, root);
				return manifest;
			}
			throw new Error(
				`Project "${slug}" is already at stage "${stage}"${stage === "iterations" ? "; pass a note to log another round" : ""}`,
			);
		}
		if (targetIndex > currentIndex) {
			if (targetIndex !== currentIndex + 1) {
				throw new Error(
					`Can only advance one step at a time; current stage is "${manifest.stage}", ` +
						`next is "${DESIGN_STAGES[currentIndex + 1]}", but "${stage}" was requested`,
				);
			}
			const requiredGate = HARD_GATES[stage];
			if (requiredGate) {
				const gate = manifest.gates[requiredGate];
				if (!gate || gate.status !== "approved") {
					throw new Error(
						`Cannot enter "${stage}": gate "${requiredGate}" must be approved first (current: ${gate?.status ?? "not set"})`,
					);
				}
			}
			manifest.steps[manifest.stage] = {
				...(opts?.artifact ? { artifact: opts.artifact } : {}),
				...(opts?.note ? { note: opts.note } : {}),
				at,
			};
		}
		if (opts?.note && (manifest.stage === "iterations" || stage === "iterations")) {
			manifest.iterations.push({ summary: opts.note, at });
		}
		manifest.stage = stage;
		manifest.updatedAt = at;
		const pendingGate = PENDING_GATES[stage];
		if (pendingGate) {
			const existing = manifest.gates[pendingGate];
			if (!existing || existing.status !== "approved") {
				manifest.gates[pendingGate] = { status: "pending", at };
			}
		}
		const lightGate = LIGHT_GATES[stage];
		if (lightGate) {
			const existing = manifest.gates[lightGate];
			if (!existing || existing.status !== "approved") {
				manifest.gates[lightGate] = { status: "informed", at };
			}
		}
		await writeManifest(slug, manifest, root);
		return manifest;
	});
}

export async function recordGateVerdict(
	slug: string,
	gate: DesignGateName,
	status: GateVerdictStatus,
	evidence: string,
	directory?: string,
): Promise<ProjectManifest> {
	validateProjectSlug(slug);
	if (!isGateName(gate)) {
		throw new Error(`Invalid gate "${String(gate)}"; must be wireframe, final, or moodboard`);
	}
	if (status !== "approved" && status !== "returned") {
		throw new Error(`Invalid verdict status "${String(status)}"; must be approved or returned`);
	}
	if (typeof evidence !== "string" || !evidence.trim()) {
		throw new Error("evidence is required and must be a non-empty string");
	}
	const root = projectsDirectory(directory);
	return enqueue(`${root}\0${slug}`, async () => {
		const manifest = await readManifest(slug, root);
		if (!manifest) throw new Error(`Project "${slug}" does not exist`);
		const at = nowIso();
		manifest.gates[gate] = {
			at,
			evidence: evidence.trim(),
			status,
		};
		if (status === "returned" && isHardGate(gate)) {
			manifest.stage = GATE_RETURN_STAGE[gate];
		}
		manifest.updatedAt = at;
		await writeManifest(slug, manifest, root);
		return manifest;
	});
}

function gateObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function approvedWithoutEvidence(gate: Record<string, unknown> | undefined): boolean {
	if (!gate || gate.status !== "approved") return false;
	const evidence = gate.evidence;
	return typeof evidence !== "string" || !evidence.trim();
}

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function isFuture(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && ms > Date.now() + FUTURE_TOLERANCE_MS;
}

/** Every `at`-like field a manifest carries, labelled by where it sits. */
function timestampFields(manifest: Record<string, unknown>): Array<[string, unknown]> {
	const out: Array<[string, unknown]> = [
		["createdAt", manifest.createdAt],
		["updatedAt", manifest.updatedAt],
	];
	const steps = manifest.steps;
	if (steps && typeof steps === "object" && !Array.isArray(steps)) {
		for (const [name, step] of Object.entries(steps as Record<string, unknown>)) {
			out.push([`steps.${name}.at`, (step as { at?: unknown } | null)?.at]);
		}
	}
	const gates = manifest.gates;
	if (gates && typeof gates === "object" && !Array.isArray(gates)) {
		for (const [name, gate] of Object.entries(gates as Record<string, unknown>)) {
			out.push([`gates.${name}.at`, (gate as { at?: unknown } | null)?.at]);
		}
	}
	const iterations = manifest.iterations;
	if (Array.isArray(iterations)) {
		iterations.forEach((record, index) => {
			out.push([`iterations[${index}].at`, (record as { at?: unknown } | null)?.at]);
		});
	}
	return out;
}

export async function auditProjects(directory?: string): Promise<AuditFinding[]> {
	const root = projectsDirectory(directory);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const findings: AuditFinding[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".project.json")) continue;
		const entrySlug = entry.name.slice(0, -".project.json".length);
		if (!isValidProjectSlug(entrySlug)) continue;
		let raw: string;
		try {
			raw = await readFile(join(root, entry.name), "utf8");
		} catch {
			findings.push({ message: `Cannot read ${entry.name}`, severity: "red", slug: entrySlug });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			findings.push({ message: `Corrupt JSON in ${entry.name}`, severity: "red", slug: entrySlug });
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			findings.push({ message: `Invalid manifest shape in ${entry.name}`, severity: "red", slug: entrySlug });
			continue;
		}
		const manifest = parsed as Record<string, unknown>;
		const stageValue = manifest.stage;
		if (!isStage(stageValue)) {
			findings.push({
				message: `Invalid stage "${String(stageValue)}" in ${entry.name}`,
				severity: "red",
				slug: entrySlug,
			});
			continue;
		}
		const si = stageIndex(stageValue);
		const gates = gateObject(manifest.gates) ?? {};
		for (const gateName of GATE_NAMES) {
			const gate = gateObject(gates[gateName]);
			if (approvedWithoutEvidence(gate)) {
				findings.push({
					message: `Gate "${gateName}" is approved but has no evidence`,
					severity: "red",
					slug: entrySlug,
				});
			}
		}
		if (si >= stageIndex("draft")) {
			const wg = gateObject(gates.wireframe);
			const wgStatus = wg?.status;
			if (wgStatus !== "approved") {
				findings.push({
					message: `Stage is "${stageValue}" but wireframe gate is not approved (status: ${String(wgStatus ?? "missing")})`,
					severity: "red",
					slug: entrySlug,
				});
			}
		}
		if (si >= stageIndex("code")) {
			const fg = gateObject(gates.final);
			const fgStatus = fg?.status;
			if (fgStatus !== "approved") {
				findings.push({
					message: `Stage is "${stageValue}" but final gate is not approved (status: ${String(fgStatus ?? "missing")})`,
					severity: "red",
					slug: entrySlug,
				});
			}
		}
		// Hand-edited manifests: the ledger is written by the tools only, so a wrong field name or a made-up clock is a red.
		const iterations = manifest.iterations;
		if (Array.isArray(iterations)) {
			iterations.forEach((record, index) => {
				const summary = (record as { summary?: unknown } | null)?.summary;
				if (typeof summary !== "string" || summary.trim() === "") {
					findings.push({
						message: `Iteration #${index + 1} has no "summary" (hand-edited manifest? rounds are logged with design_project_set_stage)`,
						severity: "red",
						slug: entrySlug,
					});
				}
			});
		}
		for (const [where, value] of timestampFields(manifest)) {
			if (isFuture(value)) {
				findings.push({
					message: `Timestamp ${where} = "${String(value)}" is in the future (hand-edited manifest? timestamps come from the tool's clock)`,
					severity: "red",
					slug: entrySlug,
				});
			}
		}
	}
	return findings;
}
