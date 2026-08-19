import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkRollback, latestSelfmodRecord, readSelfmodRecords, runSelfMod } from "../her-core/selfmod.ts";
import { runSelfmodPickup } from "../her-core/selfmod-pickup.ts";
import { defaultRunEvalFixtures, defaultRunTests } from "../her-core/selfmod-runners.ts";
import type { SelfModProposal } from "../her-core/selfmod-types.ts";
import { runSkillsDrift } from "../her-core/skills-drift.ts";
import { sendTelegramMessage } from "../her-core/telegram.ts";
import { writeLine } from "./render.ts";
import type { CliIo } from "./types.ts";
import { errorMessage, requireOptionValue, UsageError } from "./utils.ts";

export async function runSelfmodRunCommand(args: string[], memoryDir: string, cwd: string, io: CliIo): Promise<number> {
	try {
		const parsed = parseRunArgs(args);
		const proposal = await loadProposal(resolve(cwd, parsed.proposalPath));
		const result = await runSelfMod({
			hooks: {
				runTests: defaultRunTests,
				runEvalFixtures: (worktreePath, ctx) =>
					defaultRunEvalFixtures({
						anchorCommit: ctx?.anchorCommit,
						git: ctx?.git,
						memoryDir,
						proposal,
						worktreePath,
					}),
			},
			memoryDir,
			proposal,
			repoRoot: cwd,
			worktreeRoot: parsed.worktreeRoot ? resolve(cwd, parsed.worktreeRoot) : defaultWorktreeRoot(),
		});
		if (parsed.json) writeLine(io.stdout, JSON.stringify(result));
		else writeLine(io.stdout, `selfmod: ${result.outcome} stage=${result.record.stage}`);
		if (result.outcome === "rejected") return 1;
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runSelfmodStatusCommand(args: string[], memoryDir: string, io: CliIo): Promise<number> {
	try {
		const parsed = parseIdArgs(args, "selfmod-status");
		const record = latestSelfmodRecord(await readSelfmodRecords(memoryDir), parsed.id);
		if (!record) {
			writeLine(io.stderr, `selfmod-status: not found: ${parsed.id}`);
			return 1;
		}
		if (parsed.json) writeLine(io.stdout, JSON.stringify(record));
		else writeLine(io.stdout, `selfmod: ${record.stage} ${record.proposal.id}`);
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runSelfmodCheckRollbackCommand(
	args: string[],
	memoryDir: string,
	cwd: string,
	io: CliIo,
): Promise<number> {
	try {
		const parsed = parseIdArgs(args, "selfmod-check-rollback");
		const result = await checkRollback({ id: parsed.id, memoryDir, repoRoot: cwd });
		if (parsed.json) writeLine(io.stdout, JSON.stringify(result));
		else writeLine(io.stdout, `selfmod-check-rollback: ${result.action} stage=${result.record.stage}`);
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

export async function runSkillsDriftCommand(
	args: string[],
	memoryDir: string,
	cwd: string,
	io: CliIo,
): Promise<number> {
	try {
		const json = parseJsonFlag(args, "skills-drift");
		const report = await runSkillsDrift({ memoryDir, persist: false, repoRoot: cwd });
		if (json) writeLine(io.stdout, JSON.stringify(report));
		else {
			writeLine(
				io.stdout,
				`skills-drift: alarm=${report.unattributed.length} info=${report.human.length} selfmod=${report.selfmod.length}`,
			);
		}
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

function parseJsonFlag(args: string[], command: string): boolean {
	let json = false;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown ${command} option: ${arg}`);
	}
	return json;
}

export async function runSelfmodPickupCommand(
	args: string[],
	memoryDir: string,
	cwd: string,
	io: CliIo,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	try {
		const parsed = parsePickupArgs(args);
		const result = await runSelfmodPickup({
			memoryDir,
			repoRoot: cwd,
			sendNotify: (text) => maybeTelegram(env, text),
			worktreeRoot: parsed.worktreeRoot ? resolve(cwd, parsed.worktreeRoot) : defaultWorktreeRoot(),
		});
		if (parsed.json) writeLine(io.stdout, JSON.stringify(result));
		else writeLine(io.stdout, `selfmod-pickup: ${result.action}`);
		return 0;
	} catch (error) {
		return fail(io, error);
	}
}

function parsePickupArgs(args: string[]): { json: boolean; worktreeRoot?: string } {
	let json = false;
	let worktreeRoot: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--worktree-root") {
			worktreeRoot = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown selfmod-pickup option: ${arg}`);
	}
	return { json, worktreeRoot };
}

async function maybeTelegram(env: NodeJS.ProcessEnv, text: string): Promise<void> {
	const token = env.HER_TELEGRAM_BOT_TOKEN?.trim() ?? "";
	const chatId = env.HER_TELEGRAM_CHAT_ID?.trim() ?? "";
	if (!token || !chatId) return;
	await sendTelegramMessage({
		baseUrl: env.HER_TELEGRAM_BASE_URL,
		chatId,
		text,
		token,
	});
}

function parseRunArgs(args: string[]): { json: boolean; proposalPath: string; worktreeRoot?: string } {
	let json = false;
	let proposalPath: string | undefined;
	let worktreeRoot: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--proposal") {
			proposalPath = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--worktree-root") {
			worktreeRoot = requireOptionValue(args[++i], arg);
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		throw new UsageError(`unknown selfmod-run option: ${arg}`);
	}
	if (!proposalPath) throw new UsageError("selfmod-run requires --proposal");
	return { json, proposalPath, worktreeRoot };
}

function parseIdArgs(args: string[], command: string): { id: string; json: boolean } {
	let json = false;
	const positional: string[] = [];
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg.startsWith("--")) throw new UsageError(`unknown ${command} option: ${arg}`);
		positional.push(arg);
	}
	if (positional.length !== 1) throw new UsageError(`${command} requires <id>`);
	return { id: positional[0], json };
}

async function loadProposal(path: string): Promise<SelfModProposal> {
	const text = await readFile(path, "utf8");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object") throw new UsageError("proposal must be a JSON object");
	const rec = value as Record<string, unknown>;
	if (typeof rec.id !== "string" || typeof rec.createdAt !== "string" || typeof rec.planSummary !== "string") {
		throw new UsageError("proposal is missing id, createdAt, or planSummary");
	}
	if (!rec.motivation || typeof rec.motivation !== "object") throw new UsageError("proposal.motivation is required");
	const motivation = rec.motivation as Record<string, unknown>;
	if (motivation.kind !== "failure-anchored" && motivation.kind !== "idea") {
		throw new UsageError("proposal.motivation.kind must be failure-anchored or idea");
	}
	if (typeof motivation.evidenceRef !== "string") throw new UsageError("proposal.motivation.evidenceRef is required");
	if (!Array.isArray(rec.targetPaths) || rec.targetPaths.some((item) => typeof item !== "string")) {
		throw new UsageError("proposal.targetPaths must be a string array");
	}
	const fieldPatch = typeof rec.patch === "string" ? rec.patch : undefined;
	const sibling = await readSiblingPatch(path);
	if (fieldPatch !== undefined && sibling !== undefined) {
		console.log("selfmod-run: patch field wins over sibling .patch");
	}
	const patch = fieldPatch !== undefined ? fieldPatch : sibling;
	return {
		id: rec.id,
		createdAt: rec.createdAt,
		motivation: { kind: motivation.kind, evidenceRef: motivation.evidenceRef },
		targetPaths: rec.targetPaths as string[],
		planSummary: rec.planSummary,
		...(patch ? { patch } : {}),
	};
}

async function readSiblingPatch(proposalPath: string): Promise<string | undefined> {
	try {
		return await readFile(proposalPath.replace(/\.json$/i, ".patch"), "utf8");
	} catch {
		return undefined;
	}
}

function defaultWorktreeRoot(): string {
	return process.env.HER_SELFMOD_WORKTREE_ROOT?.trim() || join(tmpdir(), "her-selfmod-worktrees");
}

function fail(io: CliIo, error: unknown): number {
	writeLine(io.stderr, errorMessage(error));
	return error instanceof UsageError ? 2 : 1;
}
