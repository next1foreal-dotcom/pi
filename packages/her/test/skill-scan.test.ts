import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/parse.ts";
import { runHerCli } from "../src/cli.ts";
import {
	FakeModel,
	initStore,
	type ModelLike,
	readJson,
	readText,
	SELFMOD_OWNED_SKILLS,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";
import { validateProposalFile } from "../src/her-core/selfmod-pickup.ts";
import {
	runSkillScanOrgan,
	SKILL_SCAN_INPUT_BUDGET_CHARS,
	SKILL_SCAN_MODEL_TIMEOUT_MS,
	SKILL_SCAN_ORGAN_SYSTEM_PROMPT,
} from "../src/her-core/skill-scan.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = new Date("2026-08-19T12:00:00.000Z");
const DAY_MS = 86_400_000;
const APPENDIX_A = `You are auditing Samantha's own skills for defects. You are not improving them, not polishing them, and not making them nicer. You are looking for one specific thing: a place where one of her skills tells her to do something that the system no longer allows, no longer supports, or now handles differently.

You will be given the full text of every skill she owns, the current self-modification rules from her prompt, and a short list of facts about how the system works today.

A CANDIDATE is a contradiction: a specific instruction in a skill, and a specific fact about the system today, that cannot both be right. Anyone reading both sides should be able to see the conflict without being told it is there.

These are NOT candidates:
  - "this could be clearer", "this could be shorter", or any style preference
  - anything that needs a prediction about the future before the problem is visible
  - a gap you think should be filled - that is an idea, not a defect
  - a disagreement between two skills where neither is wrong on its own
  - anything you cannot quote both sides of

Iron rules:
  - Quote both sides exactly. If you cannot quote the conflicting fact, there is no candidate.
  - One candidate per run - the strongest one. Never a list.
  - Do NOT write a patch, a diff, or the corrected text. Finding it is your job. Fixing it is hers, and taking that from her is the one unforgivable failure here.
  - No candidate is the normal result. Empty output is a good output. Say NO_CANDIDATE and stop. Inventing one to look useful is the worst thing you can do in this job.

Output exactly one of the following, and nothing else.

NO_CANDIDATE

or:

SKILL: <skill directory name>
QUOTE: <the exact instruction from the skill, verbatim>
CONFLICTS WITH: <the exact current fact, verbatim, and where it comes from>
WHY THEY CANNOT BOTH BE RIGHT: <two sentences, concrete>
WHAT FOLLOWING THE SKILL WOULD CAUSE: <the real consequence, one sentence>
SLUG: <lowercase-with-dashes, at most 40 characters, naming the fix and not the problem>
PLAN: <one paragraph, under 400 characters: what goes wrong today, what should change, and why that fixes it instead of papering over it>`;

const QUOTE = "If the verdict is keep, edit the skill file directly.";
const CONFLICT = "A failure-anchored proposal without a patch is rejected at intake. (her.md ## Self-modification)";
const PLAN =
	"Step 4 still says to edit the skill file directly, which bypasses the selfmod pipeline. Rewrite it so a keep verdict produces a selfmod proposal instead of a direct edit.";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-skill-scan-"));
	await initStore(root);
	return root;
}

async function seedLastSkillScan(store: string, last: string): Promise<void> {
	await writeJson(join(store, ".her", "state.json"), {
		cursor: null,
		last_consolidate: null,
		last_synthesize: null,
		last_skill_scan: last,
	});
}

function candidateDoc(
	over: {
		cause?: string;
		conflict?: string;
		extra?: string;
		plan?: string;
		quote?: string;
		skill?: string;
		slug?: string;
		why?: string;
	} = {},
): string {
	const lines = [
		`SKILL: ${over.skill ?? "her-scan"}`,
		`QUOTE: ${over.quote ?? QUOTE}`,
		`CONFLICTS WITH: ${over.conflict ?? CONFLICT}`,
		`WHY THEY CANNOT BOTH BE RIGHT: ${over.why ?? "The skill commands a direct edit. The pipeline forbids ungated edits."}`,
		`WHAT FOLLOWING THE SKILL WOULD CAUSE: ${over.cause ?? "An ungated edit that registers as unattributed drift."}`,
		`SLUG: ${over.slug ?? "route-scan-to-pipeline"}`,
		`PLAN: ${over.plan ?? PLAN}`,
	];
	if (over.extra) lines.push(over.extra);
	return lines.join("\n");
}

async function listRelFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) await walk(abs);
			else if (entry.isFile()) out.push(relative(root, abs).split("\\").join("/"));
		}
	}
	await walk(root);
	return out.sort();
}

async function snapshot(root: string): Promise<Map<string, string>> {
	const files = await listRelFiles(root);
	const map = new Map<string, string>();
	for (const rel of files) {
		const buf = await readFile(join(root, rel));
		map.set(rel, createHash("sha256").update(buf).digest("hex"));
	}
	return map;
}

function extraWrites(before: Map<string, string>, after: Map<string, string>): string[] {
	const extras: string[] = [];
	for (const [rel, hash] of after) {
		if (isAllowedWrite(rel)) continue;
		if (before.get(rel) !== hash) extras.push(rel);
	}
	for (const rel of before.keys()) {
		if (isAllowedWrite(rel)) continue;
		if (!after.has(rel)) extras.push(`deleted:${rel}`);
	}
	return extras.sort();
}

function isAllowedWrite(rel: string): boolean {
	return (
		rel.startsWith("proposals/selfmod/drafts/") ||
		rel === ".her/state.json" ||
		rel === ".her/lock" ||
		rel.startsWith("audit/")
	);
}

async function skillSnapshots(root: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const name of SELFMOD_OWNED_SKILLS) {
		const rel = `packages/her/pi-package/skills/${name}/SKILL.md`;
		const buf = await readFile(join(root, ...rel.split("/")));
		map.set(rel, createHash("sha256").update(buf).digest("hex"));
	}
	return map;
}

async function listTopLevelSelfmod(memoryDir: string): Promise<string[]> {
	const dir = join(memoryDir, "proposals", "selfmod");
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

async function draftsDir(store: string): Promise<string> {
	const dir = join(store, "proposals", "selfmod", "drafts");
	await mkdir(dir, { recursive: true });
	return dir;
}

async function listDraftFiles(store: string): Promise<string[]> {
	const dir = join(store, "proposals", "selfmod", "drafts");
	try {
		const names = await readdir(dir);
		return names.sort();
	} catch {
		return [];
	}
}

async function lastSkillScan(store: string): Promise<string | undefined> {
	const state = await readJson<{ last_skill_scan?: string }>(join(store, ".her", "state.json"), {});
	return state.last_skill_scan;
}

async function runCli(
	store: string,
	args: string[],
	opts: { cwd?: string; model?: ModelLike; modelTimeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
	stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
	const env: NodeJS.ProcessEnv = { ...process.env, HER_MEMORY_DIR: store };
	if (opts.model) {
		env.HER_LLM_API_KEY = "";
		env.HER_SUMMARY_API_KEY = "";
		env.HER_SUMMARY_BASE_URL = "";
		env.HER_SUMMARY_MODEL = "";
		env.HER_RELAY_URL = "";
		env.HER_RELAY_KEY = "";
		env.HER_RELAY_MODEL = "";
		env.HER_DEEPSEEK_KEY = "";
		env.DEEPSEEK_API_KEY = "";
		env.HER_DEEPSEEK_BASE_URL = "";
		env.HER_DEEPSEEK_MODEL = "";
		env.HER_LOCAL_OPENAI_URL = "";
		env.HER_LOCAL_OPENAI_KEY = "";
		env.HER_LOCAL_OPENAI_MODEL = "";
	}
	const code = await runHerCli(args, env, opts.cwd ?? repoRoot, {
		stdout,
		stderr,
		...(opts.model ? { model: opts.model } : {}),
		...(opts.modelTimeoutMs !== undefined ? { modelTimeoutMs: opts.modelTimeoutMs } : {}),
	});
	return {
		code,
		stdout: Buffer.concat(outChunks).toString("utf8"),
		stderr: Buffer.concat(errChunks).toString("utf8"),
	};
}

async function runOrgan(
	store: string,
	opts: {
		ifDue?: boolean;
		model?: ModelLike;
		modelTimeoutMs?: number;
		repoRoot?: string;
		tg?: string[];
	},
) {
	const logs: string[] = [];
	const tg = opts.tg ?? [];
	const result = await runSkillScanOrgan(store, {
		ifDue: opts.ifDue,
		model: opts.model,
		modelTimeoutMs: opts.modelTimeoutMs,
		now: NOW,
		repoRoot: opts.repoRoot ?? repoRoot,
		log: (line) => logs.push(line),
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	return { logs, result, tg };
}

test("appendix A system prompt is verbatim", () => {
	assert.equal(SKILL_SCAN_ORGAN_SYSTEM_PROMPT, APPENDIX_A);
	assert.equal(SKILL_SCAN_MODEL_TIMEOUT_MS, 15 * 60 * 1000);
	assert.equal(SKILL_SCAN_INPUT_BUDGET_CHARS, 48_000);
});

test("GIVEN --if-due and not due WHEN run THEN exit 0, ran=false, zero files, zero TG, last_skill_scan unchanged", async () => {
	const store = await tempStore();
	const last = NOW.toISOString();
	await seedLastSkillScan(store, last);
	const before = await snapshot(store);
	const model = new FakeModel("NO_CANDIDATE");
	const { result, tg } = await runOrgan(store, { ifDue: true, model });
	assert.equal(result.ran, false);
	assert.equal(result.due, false);
	assert.equal(result.skippedReason, "not-due");
	assert.equal(result.error, undefined);
	assert.deepEqual(result.candidates, []);
	assert.deepEqual(tg, []);
	assert.equal(model.calls.length, 0);
	assert.deepEqual(await listDraftFiles(store), []);
	assert.equal(await lastSkillScan(store), last);
	assert.deepEqual(extraWrites(before, await snapshot(store)), []);
	const { code, stdout } = await runCli(store, ["skill-scan", "--if-due", "--json"]);
	assert.equal(code, 0);
	const payload = JSON.parse(stdout) as { ran: boolean; due: boolean; skippedReason?: string };
	assert.equal(payload.ran, false);
	assert.equal(payload.due, false);
	assert.equal(payload.skippedReason, "not-due");
});

test("GIVEN an open selfmod-*.json draft WHEN due THEN model is not called, zero files, last_skill_scan unchanged", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastSkillScan(store, last);
	const drafts = await draftsDir(store);
	await writeFile(
		join(drafts, "selfmod-20260819-already-open.json"),
		`${JSON.stringify({ id: "selfmod-20260819-already-open" }, null, 2)}\n`,
		"utf8",
	);
	const before = await snapshot(store);
	const model = new FakeModel(undefined, true);
	const { result, tg } = await runOrgan(store, { ifDue: true, model });
	assert.equal(result.ran, false);
	assert.equal(result.due, true);
	assert.equal(result.skippedReason, "draft-open");
	assert.equal(result.error, undefined);
	assert.equal(model.calls.length, 0);
	assert.deepEqual(tg, []);
	assert.deepEqual(await listDraftFiles(store), ["selfmod-20260819-already-open.json"]);
	assert.equal(await lastSkillScan(store), last);
	assert.deepEqual(extraWrites(before, await snapshot(store)), []);
});

test("GIVEN drafts/ contains only TEMPLATE.json WHEN due THEN the scan proceeds", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastSkillScan(store, last);
	const drafts = await draftsDir(store);
	await writeFile(
		join(drafts, "TEMPLATE.json"),
		`${JSON.stringify({ id: "selfmod-YYYYMMDD-short-slug" }, null, 2)}\n`,
		"utf8",
	);
	const model = new FakeModel("NO_CANDIDATE");
	const { result, tg } = await runOrgan(store, { ifDue: true, model });
	assert.equal(result.ran, true);
	assert.equal(result.due, true);
	assert.deepEqual(result.candidates, []);
	assert.deepEqual(tg, []);
	assert.equal(model.calls.length, 1);
	assert.deepEqual(await listDraftFiles(store), ["TEMPLATE.json"]);
	assert.equal(await lastSkillScan(store), NOW.toISOString());
});

test("GIVEN model returns NO_CANDIDATE WHEN run THEN zero files, zero TG, last_skill_scan advances, exit 0", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastSkillScan(store, last);
	const before = await snapshot(store);
	const model = new FakeModel("NO_CANDIDATE");
	const { result, tg } = await runOrgan(store, { model });
	assert.equal(result.ran, true);
	assert.equal(result.due, true);
	assert.deepEqual(result.candidates, []);
	assert.equal(result.error, undefined);
	assert.deepEqual(tg, []);
	assert.ok(model.calls[0]?.prompt.includes(SKILL_SCAN_ORGAN_SYSTEM_PROMPT));
	assert.deepEqual(await listDraftFiles(store), []);
	assert.equal(await lastSkillScan(store), NOW.toISOString());
	assert.deepEqual(extraWrites(before, await snapshot(store)), []);
});

test("GIVEN a valid candidate WHEN run THEN drafts/ gains exactly two files, TG once, last_skill_scan advances", async () => {
	const store = await tempStore();
	const model = new FakeModel(candidateDoc());
	const tg: string[] = [];
	const { result } = await runOrgan(store, { model, tg });
	assert.equal(result.ran, true);
	assert.equal(result.due, true);
	assert.equal(result.candidates.length, 1);
	const drafts = await listDraftFiles(store);
	assert.equal(drafts.length, 2);
	assert.ok(drafts.includes("FINDING-2026-08-19-route-scan-to-pipeline.md"));
	assert.ok(drafts.includes("selfmod-20260819-route-scan-to-pipeline.json"));
	const finding =
		(await readText(
			join(store, "proposals", "selfmod", "drafts", drafts[0].startsWith("FINDING") ? drafts[0] : drafts[1]),
		)) ?? "";
	assert.match(finding, /skill-scan organ/);
	assert.match(finding, /2026-08-19/);
	assert.match(finding, /her-scan/);
	assert.ok(finding.includes(QUOTE));
	assert.ok(finding.includes(CONFLICT));
	assert.match(finding, /What this does NOT claim/i);
	const jsonName = drafts.find((name) => name.endsWith(".json")) ?? "";
	const rec = JSON.parse((await readText(join(store, "proposals", "selfmod", "drafts", jsonName))) ?? "{}") as Record<
		string,
		unknown
	>;
	assert.equal("patch" in rec, false);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", /FINDING-2026-08-19-route-scan-to-pipeline\.md/);
	assert.match(tg[0] ?? "", /selfmod-20260819-route-scan-to-pipeline\.json/);
	assert.equal(await lastSkillScan(store), NOW.toISOString());
});

test("GIVEN a valid candidate WHEN run THEN JSON without patch is rejected as proposal carries no patch; with a fake patch it is ACCEPTED", async () => {
	const store = await tempStore();
	const model = new FakeModel(candidateDoc({ skill: "her-intake", slug: "intake-to-pipeline" }));
	const { result } = await runOrgan(store, { model });
	assert.equal(result.ran, true);
	const jsonPath = join(store, "proposals", "selfmod", "drafts", "selfmod-20260819-intake-to-pipeline.json");
	const raw = (await readText(jsonPath)) ?? "";
	assert.notEqual(raw, "");
	const rejected = validateProposalFile(raw, store);
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "proposal carries no patch");
	const rec = JSON.parse(raw) as Record<string, unknown>;
	rec.patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
	const accepted = validateProposalFile(`${JSON.stringify(rec, null, 2)}\n`, store);
	assert.equal(accepted.ok, true);
});

test("GIVEN planSummary over 500 chars WHEN run THEN the organ truncates to a legal scaffold", async () => {
	const store = await tempStore();
	const model = new FakeModel(candidateDoc({ plan: "a".repeat(600), slug: "trim-plan-summary" }));
	const { result } = await runOrgan(store, { model });
	assert.equal(result.ran, true);
	const raw =
		(await readText(join(store, "proposals", "selfmod", "drafts", "selfmod-20260819-trim-plan-summary.json"))) ?? "";
	const rec = JSON.parse(raw) as { planSummary: string };
	assert.ok(rec.planSummary.length <= 500);
	const rejected = validateProposalFile(raw, store);
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "proposal carries no patch");
});

test("GIVEN model emits PATCH after PLAN WHEN run THEN planSummary has no diff text and JSON has no patch key", async () => {
	const store = await tempStore();
	const patchTail = [
		"PATCH: <diff>",
		"--- a/packages/her/pi-package/skills/her-scan/SKILL.md",
		"+++ b/packages/her/pi-package/skills/her-scan/SKILL.md",
		"@@ -10,3 +10,4 @@",
		"-If the verdict is keep, edit the skill file directly.",
		"+If the verdict is keep, write a selfmod proposal.",
	].join("\n");
	const model = new FakeModel(candidateDoc({ slug: "no-diff-in-plan", extra: patchTail }));
	const { result } = await runOrgan(store, { model });
	assert.equal(result.ran, true);
	const raw =
		(await readText(join(store, "proposals", "selfmod", "drafts", "selfmod-20260819-no-diff-in-plan.json"))) ?? "";
	const rec = JSON.parse(raw) as Record<string, unknown>;
	assert.equal("patch" in rec, false);
	assert.equal(typeof rec.planSummary, "string");
	const planSummary = rec.planSummary as string;
	assert.doesNotMatch(planSummary, /---/);
	assert.doesNotMatch(planSummary, /\+\+\+/);
	assert.doesNotMatch(planSummary, /@@/);
});

test(
	"GIVEN a hanging model WHEN run with a short timeout THEN it ends in seconds, non-zero, TG once, last_skill_scan unchanged",
	{ timeout: 5000 },
	async () => {
		const store = await tempStore();
		const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
		await seedLastSkillScan(store, last);
		const hanging: ModelLike = {
			complete() {
				return new Promise<string>(() => {});
			},
		};
		const started = Date.now();
		const { result, tg } = await runOrgan(store, { ifDue: true, model: hanging, modelTimeoutMs: 50 });
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 2000, `timeout path hung (${elapsed}ms)`);
		assert.equal(result.ran, false);
		assert.equal(result.due, true);
		assert.ok(result.error && /timed out/i.test(result.error));
		assert.equal(tg.length, 1);
		assert.match(tg[0] ?? "", /skill-scan failed/i);
		assert.deepEqual(await listDraftFiles(store), []);
		assert.equal(await lastSkillScan(store), last);
	},
);

test("GIVEN model throw or empty response WHEN run THEN loud failure, TG once, last_skill_scan unchanged", async () => {
	for (const model of [
		new FakeModel(undefined, true),
		new FakeModel(""),
		new FakeModel("chatty garbage with no fields"),
	]) {
		const store = await tempStore();
		const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
		await seedLastSkillScan(store, last);
		const { result, tg } = await runOrgan(store, { ifDue: true, model });
		assert.equal(result.ran, false, String(model.calls.length));
		assert.ok(result.error && result.error.length > 0);
		assert.equal(result.skippedReason, undefined);
		assert.equal(tg.length, 1);
		assert.match(tg[0] ?? "", /skill-scan failed/i);
		assert.deepEqual(await listDraftFiles(store), []);
		assert.equal(await lastSkillScan(store), last);
	}
});

test("iron bans: no patch key, no top-level inbox write, no SKILL.md mutation, at most one candidate", async () => {
	const store = await tempStore();
	const skillsBefore = await skillSnapshots(repoRoot);
	const topBefore = await listTopLevelSelfmod(store);
	const two = `${candidateDoc({ slug: "first-fix", extra: "PATCH: diff --git a/foo b/foo\n+evil\n" })}\n\n${candidateDoc({ skill: "her-intake", slug: "second-fix" })}`;
	const model = new FakeModel(two);
	const before = await snapshot(store);
	const { result } = await runOrgan(store, { model });
	assert.equal(result.ran, true);
	assert.equal(result.candidates.length, 1);
	const drafts = await listDraftFiles(store);
	assert.equal(drafts.filter((name) => name.endsWith(".json")).length, 1);
	assert.equal(drafts.filter((name) => name.endsWith(".md")).length, 1);
	assert.deepEqual(
		drafts.filter((name) => name.endsWith(".patch")),
		[],
	);
	const jsonName = drafts.find((name) => name.endsWith(".json")) ?? "";
	const rec = JSON.parse((await readText(join(store, "proposals", "selfmod", "drafts", jsonName))) ?? "{}") as Record<
		string,
		unknown
	>;
	assert.equal("patch" in rec, false);
	assert.deepEqual(await listTopLevelSelfmod(store), topBefore);
	assert.deepEqual(await skillSnapshots(repoRoot), skillsBefore);
	assert.deepEqual(extraWrites(before, await snapshot(store)), []);
});

test("GIVEN assembled input over 48000 chars WHEN run THEN the prompt names which skills were truncated", async () => {
	const fx = await mkdtemp(join(tmpdir(), "her-skill-scan-repo-"));
	const herMd = [
		"## Voice",
		"",
		"ignore me",
		"",
		"## Self-modification",
		"",
		"You can change your own skills.",
		"",
		"## Trust Boundaries",
		"",
		"Code: always to branches.",
		"",
	].join("\n");
	await writeText(join(fx, "packages", "her", "pi-package", "prompts", "her.md"), herMd);
	for (const name of SELFMOD_OWNED_SKILLS) {
		await writeText(
			join(fx, "packages", "her", "pi-package", "skills", name, "SKILL.md"),
			`# ${name}\n\n${"x".repeat(10_000)}\n`,
		);
	}
	const store = await tempStore();
	const model = new FakeModel("NO_CANDIDATE");
	const { result } = await runOrgan(store, { model, repoRoot: fx });
	assert.equal(result.ran, true);
	const prompt = model.calls[0]?.prompt ?? "";
	assert.match(prompt, /truncated skills/i);
	assert.match(prompt, /her-telegram-bridge-smoke/);
});

test("parseArgs skill-scan [--if-due] [--json]", () => {
	assert.deepEqual(parseArgs(["skill-scan"]), { kind: "skill-scan", json: false, ifDue: false });
	assert.deepEqual(parseArgs(["skill-scan", "--if-due", "--json"]), {
		kind: "skill-scan",
		json: true,
		ifDue: true,
	});
});
