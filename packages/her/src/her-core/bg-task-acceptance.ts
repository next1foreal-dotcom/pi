/**
 * G-206 — mechanical acceptance for dispatched background tasks.
 *
 * A worker's exit code answers "did the process finish", never "does the work hold up".
 * Everything here exists to keep those two apart: after the worker is dead, the task runner
 * executes a set of gate commands in the task's own worktree, and only a task whose gates all
 * ran and exited 0 may be reported green.
 *
 * Three properties make this a gate rather than a promise, and each one is a placement decision
 * rather than a check:
 *
 *  1. The gate plan is resolved and written down **at spawn time**, from the code root rather
 *     than from the worktree (see `loadRepoGatePlan`). A worker cannot weaken the gates it will
 *     be judged by: by the time it runs, the plan is already frozen on disk, and the manifest it
 *     can reach inside its own worktree is a copy nobody reads again.
 *  2. The gate results are written by the runner **after the worker process has exited**, so a
 *     worker cannot pre-forge the results file — anything it wrote there gets overwritten.
 *  3. A worker's own acceptance report is believed only where each claim matches a measurement
 *     the runner took independently (same command, same exit code, same output digest).
 *     A claim with no evidence, or evidence that disagrees with the runner, is refused.
 *
 * Every failure direction lands on refusal: a gate that fails, a gate that never launched, a
 * planned gate with no result, an error inside the runner. The only path to green is evidence.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ReviewEvidenceItem, verifyEvidence } from "./review-evidence.ts";

/** Where a code repo declares the gates its dispatched tasks must pass. */
export const REPO_GATE_MANIFEST_RELATIVE_PATH = ".pi/her-gates.json";

/** Where a worker may file its own acceptance report, relative to its working directory. */
export const ACCEPTANCE_REPORT_FILENAME = ".her-acceptance-report.json";

/** Sidecars the runner and launcher exchange, relative to the task directory. */
export const gatePlanFilename = (taskId: string): string => `${taskId}.gates.json`;
export const acceptanceRunFilename = (taskId: string): string => `${taskId}.acceptance.json`;

/** How much gate output is inlined into the task record; the rest stays in the gate log. */
const OUTPUT_EXCERPT_CAP = 600;

export const EVIDENCE_GATE_NAME = "evidence-verified";
export type AcceptanceGateType = "command" | "evidence-verified";

/** One mechanical check. argv only — never a shell string, so nothing re-parses it. */
export type AcceptanceGate = {
	name: string;
	command: string[];
	type?: AcceptanceGateType;
	timeoutMs?: number;
};

export type GatePlanSource = "task" | "repo";

export type GatePlan = {
	source: GatePlanSource;
	gates: AcceptanceGate[];
};

/**
 * What the runner actually observed. `exitCode: null` together with `crashed` means the gate
 * never produced a verdict at all (the binary was missing, the run timed out) — which is a
 * refusal, not a pass.
 */
export type GateRun = {
	name: string;
	command: string[];
	exitCode: number | null;
	crashed?: string;
	outputDigest: string;
	outputBytes: number;
	outputHead: string;
	/** Last bytes of the output — where a test runner puts the part that explains a failure. */
	outputTail?: string;
	logPath: string;
	durationMs: number;
};

export type AcceptanceRun = {
	gates: GateRun[];
	startedAt: string;
	endedAt: string;
	/** Set when the runner itself failed while executing gates. Fail loud, never green. */
	error?: string;
};

export type AcceptanceClaim = {
	claim: string;
	command?: string[];
	exitCode?: number;
	outputDigest?: string;
};

export type AcceptanceReport = { claims: AcceptanceClaim[] };

export type AcceptanceVerdict = "green" | "rejected-needs-evidence" | "unverified";

export type AcceptanceReasonCode =
	| "no_gates"
	| "gate_failed"
	| "gate_crashed"
	| "gate_missing"
	| "runner_error"
	| "missing_evidence"
	| "claim_unverifiable"
	| "evidence_unverified";

export type AcceptanceReason = { code: AcceptanceReasonCode; detail: string };

export type AcceptanceGateSummary = {
	name: string;
	exitCode: number | null;
	digest: string;
	logPath: string;
	/**
	 * A truncated, secret-redacted excerpt — carried only for gates that did not pass, so the
	 * record answers "why was this refused" without anyone opening the log, while a green task's
	 * record stays small. The full output is always at `logPath`.
	 */
	excerpt?: string;
};

export type AcceptanceOutcome = {
	verdict: AcceptanceVerdict;
	reasons: AcceptanceReason[];
	gates: AcceptanceGateSummary[];
};

/** Stable identity for "the same command", so a claim can be matched against a measurement. */
function commandKey(command: readonly string[]): string {
	return command.join("\u0000");
}

function asCommand(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	if (!value.every((x) => typeof x === "string" && x.length > 0)) return null;
	return [...value];
}

/**
 * Validate a gate plan. A malformed entry throws rather than being dropped: a gate that
 * silently disappears is the one failure mode that turns this whole mechanism back into
 * paper — everything would still go green, just without being checked.
 */
export function parseGatePlan(raw: unknown, source: GatePlanSource): GatePlan {
	if (!raw || typeof raw !== "object") throw new Error("gate plan must be an object with a `gates` array");
	const gatesRaw = (raw as { gates?: unknown }).gates;
	if (!Array.isArray(gatesRaw)) throw new Error("gate plan `gates` must be an array");
	const gates: AcceptanceGate[] = gatesRaw.map((entry, index) => {
		if (!entry || typeof entry !== "object") throw new Error(`gates[${index}] must be an object`);
		const { name, command, timeoutMs, type } = entry as {
			name?: unknown;
			command?: unknown;
			timeoutMs?: unknown;
			type?: unknown;
		};
		if (typeof name !== "string" || !name.trim()) throw new Error(`gates[${index}].name must be a non-empty string`);
		const gateType = type ?? (name.trim() === EVIDENCE_GATE_NAME ? "evidence-verified" : "command");
		if (gateType !== "command" && gateType !== "evidence-verified") {
			throw new Error(`gates[${index}].type must be command or evidence-verified`);
		}
		const argv = asCommand(command) ?? (gateType === "evidence-verified" ? [process.execPath, "-e", "0"] : null);
		if (!argv) throw new Error(`gates[${index}].command must be a non-empty array of non-empty strings`);
		if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
			throw new Error(`gates[${index}].timeoutMs must be a positive number`);
		}
		return {
			name: name.trim(),
			command: argv,
			...(gateType === "evidence-verified" ? { type: gateType } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		};
	});
	const seen = new Set<string>();
	for (const gate of gates) {
		if (seen.has(gate.name)) throw new Error(`duplicate gate name: ${gate.name}`);
		seen.add(gate.name);
	}
	return { source, gates };
}

/**
 * Read the repo's gate manifest from the code root — deliberately not from the worktree the
 * task will run in (property 1 in the module comment). Absent manifest is a legitimate answer
 * (`null` → the task ends up `unverified`); a corrupt one is not, and throws.
 */
export async function loadRepoGatePlan(codeRoot: string): Promise<GatePlan | null> {
	const path = join(codeRoot, REPO_GATE_MANIFEST_RELATIVE_PATH);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		throw new Error(`gate manifest is not valid JSON (${path}): ${error instanceof Error ? error.message : error}`);
	}
	try {
		return parseGatePlan(raw, "repo");
	} catch (error) {
		throw new Error(`gate manifest is invalid (${path}): ${error instanceof Error ? error.message : error}`);
	}
}

/** A worker's self-report is optional; a malformed one is treated as no report at all. */
export function parseAcceptanceReport(raw: unknown): AcceptanceReport | null {
	if (!raw || typeof raw !== "object") return null;
	const claimsRaw = (raw as { claims?: unknown }).claims;
	if (!Array.isArray(claimsRaw)) return null;
	const claims: AcceptanceClaim[] = [];
	for (const entry of claimsRaw) {
		if (!entry || typeof entry !== "object") continue;
		const { claim, command, exitCode, outputDigest } = entry as Record<string, unknown>;
		claims.push({
			claim: typeof claim === "string" ? claim : "",
			...(asCommand(command) ? { command: asCommand(command) as string[] } : {}),
			...(typeof exitCode === "number" ? { exitCode } : {}),
			...(typeof outputDigest === "string" ? { outputDigest } : {}),
		});
	}
	return { claims };
}

export type EvidenceGateResult = {
	evidence: ReviewEvidenceItem[];
	verified: boolean;
	reasons: AcceptanceReason[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function parseEvidenceBlock(output: string): { items: ReviewEvidenceItem[]; error?: string } {
	const match = /```json\s+evidence\s*\r?\n([\s\S]*?)```/i.exec(output);
	if (!match) return { items: [], error: "no evidence block found" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1] ?? "");
	} catch (error) {
		return {
			items: [],
			error: `evidence block is not valid JSON: ${error instanceof Error ? error.message : error}`,
		};
	}
	const rawItems = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed.evidence)
			? parsed.evidence
			: [];
	return {
		items: rawItems.map((item) => {
			const value = isRecord(item) ? item : {};
			return {
				file: typeof value.file === "string" ? value.file : "",
				...(typeof value.lines === "string" || typeof value.lines === "number"
					? { lines: String(value.lines) }
					: {}),
				claim: typeof value.claim === "string" ? value.claim : "",
			};
		}),
	};
}

function collectJsonlText(value: unknown, parts: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectJsonlText(item, parts);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "text" && typeof child === "string") parts.push(child);
		else collectJsonlText(child, parts);
	}
}

/** Extract text fields from JSONL records after JSON.parse restores escaped newlines. */
export function extractJsonlText(log: string): string {
	const parts: string[] = [];
	for (const line of log.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			collectJsonlText(JSON.parse(line), parts);
		} catch {
			// Non-JSON runner lines are expected; only valid JSON records can carry worker text.
		}
	}
	return parts.join("\n");
}

export type EvidenceOutputSource = "result file" | "raw log" | "jsonl log";
export type EvidenceOutputSelection = { output: string; source: EvidenceOutputSource } | null;

/**
 * The result file is the designated report whenever it exists. Only a missing result file may
 * fall back to the raw log and then the extracted JSONL text; a present but empty or unsupported
 * result must remain a refusal instead of being silently replaced by another channel.
 */
export function selectEvidenceOutput(resultText: string | null | undefined, rawLog: string): EvidenceOutputSelection {
	if (resultText !== null && resultText !== undefined) return { source: "result file", output: resultText };

	const candidates: { source: EvidenceOutputSource; output: string }[] = [
		{ source: "raw log", output: rawLog },
		{ source: "jsonl log", output: extractJsonlText(rawLog) },
	];
	for (const candidate of candidates) {
		if (parseEvidenceBlock(candidate.output).items.length > 0) return candidate;
	}
	return null;
}

export function extractEvidenceItems(output: string): ReviewEvidenceItem[] {
	return parseEvidenceBlock(output).items;
}

export function verifyEvidenceGate(output: string, cwd: string, missingEvidenceDetail?: string): EvidenceGateResult {
	const parsed = parseEvidenceBlock(output);
	if (parsed.items.length === 0) {
		return {
			evidence: [],
			verified: false,
			reasons: [
				{
					code: "missing_evidence",
					detail: `evidence-verified: ${missingEvidenceDetail ?? parsed.error ?? "no evidence items"}`,
				},
			],
		};
	}
	const evidence = verifyEvidence(parsed.items, cwd);
	const failures = evidence.filter((item) => item.verified !== true || !item.file.trim() || !item.claim.trim());
	return {
		evidence,
		verified: failures.length === 0,
		reasons: failures.map((item) => ({
			code: "evidence_unverified",
			detail: `evidence ${item.file}:${item.lines ?? "?"} is unverified${item.verify_note ? `: ${item.verify_note}` : ""}`,
		})),
	};
}

function isEvidenceGate(gate: AcceptanceGate): boolean {
	return gate.type === "evidence-verified" || gate.name === EVIDENCE_GATE_NAME;
}
/**
 * The verdict. Pure on purpose: everything it needs has already been measured, so the decision
 * itself is inspectable and testable without spawning anything.
 */
export function judgeAcceptance(input: {
	plan: GatePlan | null;
	run: AcceptanceRun | null;
	report: AcceptanceReport | null;
	evidenceOutput?: string;
	evidenceCwd?: string;
	evidenceFailureDetail?: string;
}): AcceptanceOutcome {
	const { plan, run, report } = input;
	const runs = run?.gates ?? [];
	const gates: AcceptanceGateSummary[] = runs.map((gate) => {
		const failed = gate.exitCode !== 0 || Boolean(gate.crashed);
		const excerpt = (gate.outputTail || gate.outputHead || "").trim();
		return {
			name: gate.name,
			exitCode: gate.exitCode,
			digest: gate.outputDigest,
			logPath: gate.logPath,
			...(failed && excerpt ? { excerpt } : {}),
		};
	});

	if (!plan || plan.gates.length === 0) {
		return {
			verdict: "unverified",
			reasons: [
				{
					code: "no_gates",
					detail: `no gate plan for this task — declare gates on the task or add ${REPO_GATE_MANIFEST_RELATIVE_PATH} to the code repo`,
				},
			],
			gates,
		};
	}

	const reasons: AcceptanceReason[] = [];

	// A task whose gates were planned but never executed is the same as unproven, not passed.
	if (!run) {
		reasons.push({ code: "gate_missing", detail: "gates were planned but no gate results were recorded" });
		return { verdict: "rejected-needs-evidence", reasons, gates };
	}
	if (run.error) {
		reasons.push({ code: "runner_error", detail: run.error });
	}

	const byName = new Map(runs.map((gate) => [gate.name, gate] as const));
	for (const gate of plan.gates) {
		const result = byName.get(gate.name);
		if (!result) {
			reasons.push({ code: "gate_missing", detail: `gate "${gate.name}" was planned but never ran` });
			continue;
		}
		if (result.crashed || result.exitCode === null) {
			reasons.push({
				code: "gate_crashed",
				detail: `gate "${gate.name}" never produced a verdict: ${result.crashed ?? "no exit code"}`,
			});
			continue;
		}
		if (result.exitCode !== 0) {
			reasons.push({
				code: "gate_failed",
				detail: `gate "${gate.name}" exited ${result.exitCode} — see ${result.logPath}`,
			});
		}
	}

	// The self-report is cross-examined against the runner's own measurements. Unbacked prose
	// and contradicted numbers are both refusals; matching evidence simply adds nothing.
	for (const claim of report?.claims ?? []) {
		const label = claim.claim.trim() || "(unlabelled claim)";
		if (!claim.command || claim.exitCode === undefined || !claim.outputDigest) {
			reasons.push({
				code: "missing_evidence",
				detail: `claim ${JSON.stringify(label)} carries no {command, exitCode, outputDigest}`,
			});
			continue;
		}
		const measured = runs.find((gate) => commandKey(gate.command) === commandKey(claim.command as string[]));
		if (!measured) {
			reasons.push({
				code: "claim_unverifiable",
				detail: `claim ${JSON.stringify(label)} cites a command no gate ran: ${claim.command.join(" ")}`,
			});
			continue;
		}
		if (measured.exitCode !== claim.exitCode || measured.outputDigest !== claim.outputDigest) {
			reasons.push({
				code: "claim_unverifiable",
				detail: `claim ${JSON.stringify(label)} disagrees with the measured run (claimed exit ${claim.exitCode}, measured ${measured.exitCode})`,
			});
		}
	}

	const evidenceGates = plan?.gates.filter(isEvidenceGate) ?? [];
	if (evidenceGates.length > 0) {
		const evidenceOutcome = verifyEvidenceGate(
			input.evidenceOutput ?? "",
			input.evidenceCwd ?? process.cwd(),
			input.evidenceFailureDetail,
		);
		reasons.push(...evidenceOutcome.reasons);
	}

	return {
		verdict: reasons.length > 0 ? "rejected-needs-evidence" : "green",
		reasons,
		gates,
	};
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text.replace(/^﻿/, ""));
	} catch {
		// Absent or unparseable: both are "no artifact". A missing gate result is caught by the
		// judge (gate_missing); a missing report simply means the worker filed none.
		return null;
	}
}

async function readTextIfPresent(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to read ${path}: ${detail}`);
	}
}

/**
 * Gather this task's acceptance artifacts and judge them.
 *
 * `taskDir` holds the harness-authored sidecars (plan, results); `workerCwd` is where the
 * worker ran and is the only place its own report is looked for.
 */
export async function evaluateTaskAcceptance(opts: {
	taskDir: string;
	taskId: string;
	workerCwd: string;
	redact?: (text: string) => string;
}): Promise<AcceptanceOutcome> {
	const { taskDir, taskId, workerCwd } = opts;
	const redact = opts.redact ?? ((text: string) => text);

	const planRaw = await readJsonIfPresent(join(taskDir, gatePlanFilename(taskId)));
	let plan: GatePlan | null = null;
	if (planRaw) {
		try {
			plan = parseGatePlan(planRaw, ((planRaw as { source?: unknown }).source as GatePlanSource) ?? "repo");
		} catch {
			// The launcher writes this file, so a corrupt one is a harness fault — surfaced as a
			// refusal rather than as "no gates", which would read as an innocent unverified task.
			return {
				verdict: "rejected-needs-evidence",
				reasons: [{ code: "runner_error", detail: `gate plan for ${taskId} is unreadable` }],
				gates: [],
			};
		}
	}

	const runRaw = (await readJsonIfPresent(join(taskDir, acceptanceRunFilename(taskId)))) as AcceptanceRun | null;
	const run = runRaw
		? {
				...runRaw,
				gates: (runRaw.gates ?? []).map((gate) => ({
					...gate,
					// The runner records a bare filename; the record carries a memory-relative path.
					logPath: `.her/tasks/${gate.logPath}`,
					// Redacted here rather than in the runner: the runner is dependency-free plain JS,
					// and this is the boundary where gate output stops being a file on disk and starts
					// being something copied into a record and a notification.
					outputHead: redact(String(gate.outputHead ?? "")).slice(0, OUTPUT_EXCERPT_CAP),
					...(gate.outputTail !== undefined
						? { outputTail: redact(String(gate.outputTail)).slice(-OUTPUT_EXCERPT_CAP) }
						: {}),
				})),
			}
		: null;

	const report = parseAcceptanceReport(await readJsonIfPresent(join(workerCwd, ACCEPTANCE_REPORT_FILENAME)));

	let evidenceOutput: string | undefined;
	let evidenceFailureDetail: string | undefined;
	if (plan?.gates.some(isEvidenceGate)) {
		try {
			const resultText = await readTextIfPresent(join(taskDir, `${taskId}.result.md`));
			const rawLog = (await readTextIfPresent(join(taskDir, `${taskId}.log`))) ?? "";
			const selected = selectEvidenceOutput(resultText, rawLog);
			evidenceOutput = selected?.output ?? "";
			if (!selected) {
				evidenceFailureDetail =
					"result file is absent; checked raw log and jsonl log, but neither contained an evidence block with items";
			} else if (selected.source === "result file" && parseEvidenceBlock(selected.output).items.length === 0) {
				const parsed = parseEvidenceBlock(selected.output);
				const reason =
					selected.output.trim().length === 0 ? "is empty" : (parsed.error ?? "contains no evidence items");
				evidenceFailureDetail = `result file exists but ${reason}; raw log and jsonl log were not consulted`;
			}
		} catch (error) {
			evidenceOutput = "";
			const detail = error instanceof Error ? error.message : String(error);
			evidenceFailureDetail = `evidence artifact read failed: ${detail}`;
		}
	}

	return judgeAcceptance({
		plan,
		run,
		report,
		...(evidenceOutput !== undefined ? { evidenceOutput, evidenceCwd: workerCwd, evidenceFailureDetail } : {}),
	});
}

/** One-line rendering for wake messages and outbox notices. */
export function formatAcceptanceLine(outcome: AcceptanceOutcome): string {
	const gates = outcome.gates.map((gate) => `${gate.name}:${gate.exitCode ?? "crash"}`).join(" ");
	const head = outcome.reasons[0];
	const why = head ? ` · ${head.code}: ${head.detail}` : "";
	const more = outcome.reasons.length > 1 ? ` (+${outcome.reasons.length - 1})` : "";
	return `acceptance ${outcome.verdict}${gates ? ` · ${gates}` : ""}${why}${more}`;
}
