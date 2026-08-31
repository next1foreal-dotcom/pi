/**
 * G-355 — acceptance judge (`her accept <taskId>`).
 *
 * Pins: evidence assembly with explicit truncation, no-diff gap, verdict disk
 * shape, fail-loud (no file), refuse-overwrite, and zero writes to the task
 * worktree / record.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "../src/cli/parse.ts";
import { runHerCli } from "../src/cli.ts";
import {
	ACCEPT_INPUT_BUDGET_CHARS,
	ACCEPT_JUDGE_SYSTEM_PROMPT,
	ACCEPT_MODEL_MAX_TOKENS,
	ACCEPT_MODEL_TIMEOUT_MS,
	acceptanceJudgeFilename,
	assembleAcceptanceEvidence,
	extractJudgeJson,
	runAcceptanceJudge,
} from "../src/her-core/acceptance-judge.ts";
import { ACCEPTANCE_REPORT_FILENAME } from "../src/her-core/bg-task-acceptance.ts";
import { createPendingRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { FakeModel, type ModelLike } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = new Date("2026-08-31T12:00:00.000Z");

const APPENDIX_A = `你是验收官(acceptance judge)。下面提供:任务书、机器门禁结果、执行方自述(可能缺)、真实 diff(非隔离任务则没有)、任务日志摘录。据此出判词。

铁律:
1. 自述只是线索,不是证据。只认门禁退出码、diff 本身、日志原文。
2. 拿任务书当评分册逐条核对;专门列出"沉默处"——任务书要求了、证据里看不到的。
3. diff 中出现任务书未授权的改动 = 记入 out_of_scope 并判 FIX,哪怕改得更好。
4. "跑不了+原因"是诚实,不因此扣分;没有证据支撑的"完成"陈述按未完成对待。
5. 门禁绿只覆盖它跑过的条目;它没盖住的关键项列入 evidence_gaps。
6. 证据被截断处已明确标注;被截断的部分不得当作"没有问题"。
7. 拿不准就 ESCALATE 并说清缺什么;没有证据的 PASS 是事故。

只输出一个 JSON 对象,不要任何其他文字:
{"verdict":"PASS|FIX|ESCALATE","reasons":["…"],"silences":["…"],"out_of_scope":["…"],"evidence_gaps":["…"],"confidence":"high|low"}`;

const PASS_JSON = JSON.stringify({
	verdict: "PASS",
	reasons: ["brief met"],
	silences: [],
	out_of_scope: [],
	evidence_gaps: [],
	confidence: "high",
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd });
	return stdout;
}

async function tempMemory(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g355-mem-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "llm:\n  model_strong: test-strong\n", "utf8");
	return root;
}

async function tempGitRepo(): Promise<{ root: string; baseSha: string }> {
	const root = await mkdtemp(join(tmpdir(), "her-g355-repo-"));
	await git(root, "init", "-q");
	await git(root, "config", "user.email", "g355@example.com");
	await git(root, "config", "user.name", "G355 Judge Test");
	await writeFile(join(root, "README.md"), "# repo\n", "utf8");
	await git(root, "add", "-A");
	await git(root, "commit", "-q", "-m", "initial");
	const baseSha = (await git(root, "rev-parse", "HEAD")).trim();
	return { root, baseSha };
}

async function writeTask(
	memory: string,
	opts: {
		id?: string;
		objective?: string;
		worktree?: string | null;
		worktreeBaseSha?: string;
		acceptance?: unknown;
		brief?: string;
		log?: string;
		status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "blocked-failed";
	} = {},
): Promise<string> {
	const record = createPendingRecord({
		objective: opts.objective ?? "do the thing",
		worker: "grok_build",
		command: ["grok", "--always-approve"],
		now: NOW,
	});
	if (opts.id) record.id = opts.id;
	record.status = opts.status ?? "completed";
	if (opts.worktree) record.worktree = opts.worktree;
	if (opts.worktreeBaseSha) record.worktreeBaseSha = opts.worktreeBaseSha;
	if (opts.acceptance !== undefined) record.acceptance = opts.acceptance;
	await saveBgTask(memory, record, `# ${record.objective}\n`);
	const dir = tasksDir(memory);
	await writeFile(join(dir, `${record.id}.brief`), opts.brief ?? "评分册:做一件授权的事。\n", "utf8");
	await writeFile(join(dir, `${record.id}.log`), opts.log ?? "worker ok\n", "utf8");
	return record.id;
}

async function snapshotTree(root: string): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	async function walk(dir: string, rel: string): Promise<void> {
		let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === ".git") continue;
			const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) await walk(abs, nextRel);
			else if (entry.isFile()) {
				const buf = await readFile(abs);
				map.set(nextRel, createHash("sha256").update(buf).digest("hex"));
			}
		}
	}
	await walk(root, "");
	return map;
}

async function runCli(
	store: string,
	args: string[],
	opts: { model?: ModelLike; modelTimeoutMs?: number } = {},
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
	const code = await runHerCli(args, env, repoRoot, {
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

test("appendix A judge prompt is verbatim", () => {
	assert.equal(ACCEPT_JUDGE_SYSTEM_PROMPT, APPENDIX_A);
	assert.equal(ACCEPT_INPUT_BUDGET_CHARS, 48_000);
	assert.equal(ACCEPT_MODEL_TIMEOUT_MS, 10 * 60 * 1000);
});

test("judge model call includes maxTokens = ACCEPT_MODEL_MAX_TOKENS (4096)", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const model = new FakeModel(PASS_JSON);
	await runAcceptanceJudge(memory, id, { model, now: NOW });
	assert.equal(model.calls.length, 1, "judge must call model exactly once");
	assert.equal(
		model.calls[0]?.maxTokens,
		ACCEPT_MODEL_MAX_TOKENS,
		"judge must pass maxTokens to prevent output truncation",
	);
	assert.equal(ACCEPT_MODEL_MAX_TOKENS, 4096, "constant must be 4096");
});

test("parseArgs accept <taskId> [--json] [--force]", () => {
	assert.deepEqual(parseArgs(["accept", "t-20260831-abc123"]), {
		kind: "accept",
		taskId: "t-20260831-abc123",
		json: false,
		force: false,
	});
	assert.deepEqual(parseArgs(["accept", "t-1", "--json", "--force"]), {
		kind: "accept",
		taskId: "t-1",
		json: true,
		force: true,
	});
});

test("assemble: no worktree evidence_gaps includes 无 diff:非隔离任务", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory, { worktree: null });
	const assembled = await assembleAcceptanceEvidence(memory, id);
	assert.equal(assembled.evidence_gaps.includes("无 diff:非隔离任务"), true, JSON.stringify(assembled.evidence_gaps));
	assert.match(assembled.text, /无门禁记录,verdict 不得引用门禁绿/);
	assert.equal(assembled.text.includes("无 diff:非隔离任务"), true);
});

test("assemble: over-budget cuts log first, never the brief", async () => {
	const memory = await tempMemory();
	const brief = `BRIEF-NEVER-CUT ${"B".repeat(40_000)}`;
	const log = `LOG-HEAD-CUT ${"T".repeat(20_000)}`;
	const id = await writeTask(memory, { brief, log });
	const assembled = await assembleAcceptanceEvidence(memory, id);
	assert.equal(assembled.text.includes(brief), true, "brief must survive whole");
	assert.match(assembled.text, /\[日志截断:只含尾部 \d+ 字符\]/);
	assert.equal(assembled.text.includes("LOG-HEAD-CUT"), false);
	assert.ok(assembled.text.length <= ACCEPT_INPUT_BUDGET_CHARS);
});

test("assemble: over-budget keeps --stat and labels per-file diff cuts", async () => {
	const repo = await tempGitRepo();
	const big = `${"D".repeat(80_000)}\n`;
	await writeFile(join(repo.root, "huge.txt"), big, "utf8");
	await writeFile(join(repo.root, "small.txt"), "tiny\n", "utf8");
	await git(repo.root, "add", "-A");
	await git(repo.root, "commit", "-q", "-m", "big change");
	const memory = await tempMemory();
	const id = await writeTask(memory, {
		worktree: repo.root,
		worktreeBaseSha: repo.baseSha,
		brief: "评分册:只改 small.txt\n",
		log: "ok\n",
	});
	const assembled = await assembleAcceptanceEvidence(memory, id);
	assert.match(assembled.text, /huge\.txt/);
	assert.match(assembled.text, /diff --stat/);
	assert.match(assembled.text, /\[diff 截断:/);
});

test("verdict JSON is written with required fields and CLI --json emits it", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const tg: string[] = [];
	const model = new FakeModel(PASS_JSON);
	const result = await runAcceptanceJudge(memory, id, {
		model,
		now: NOW,
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.error, undefined, result.error);
	assert.equal(result.ran, true);
	const path = join(tasksDir(memory), acceptanceJudgeFilename(id));
	const disk = JSON.parse(await readFile(path, "utf8")) as {
		verdict: string;
		reasons: string[];
		silences: string[];
		out_of_scope: string[];
		evidence_gaps: string[];
		confidence: string;
		model: string;
		at: string;
	};
	assert.equal(disk.verdict, "PASS");
	assert.ok(Array.isArray(disk.reasons));
	assert.ok(Array.isArray(disk.silences));
	assert.ok(Array.isArray(disk.out_of_scope));
	assert.ok(Array.isArray(disk.evidence_gaps));
	assert.equal(disk.confidence, "high");
	assert.ok(typeof disk.model === "string" && disk.model.length > 0);
	assert.equal(disk.at, NOW.toISOString());
	assert.equal(disk.evidence_gaps.includes("无 diff:非隔离任务"), true);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", new RegExp(`${id}`));
	assert.match(tg[0] ?? "", /PASS/);
	assert.equal(model.calls[0]?.prompt.startsWith(APPENDIX_A), true);
	assert.equal(model.calls[0]?.strong, true);

	const { code, stdout } = await runCli(memory, ["accept", id, "--json", "--force"], {
		model: new FakeModel(PASS_JSON),
	});
	assert.equal(code, 0);
	const payload = JSON.parse(stdout) as { verdict: string; at: string };
	assert.equal(payload.verdict, "PASS");
});

test("model failure does not write a verdict file, exits non-zero, notifies", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const tg: string[] = [];
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(undefined, true),
		now: NOW,
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, false);
	assert.ok(result.error);
	assert.equal(
		await readFile(join(tasksDir(memory), acceptanceJudgeFilename(id)), "utf8").catch(() => "missing"),
		"missing",
	);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", /accept failed/i);

	const { code, stderr } = await runCli(memory, ["accept", id, "--json"], {
		model: new FakeModel("this is not json"),
	});
	assert.notEqual(code, 0);
	assert.match(stderr, /accept failed/i);
	assert.equal(
		await readFile(join(tasksDir(memory), acceptanceJudgeFilename(id)), "utf8").catch(() => "missing"),
		"missing",
	);
});

test("fenced json verdict parses", async () => {
	const fenced = ["```json", PASS_JSON, "```"].join("\n");
	const extracted = extractJudgeJson(fenced);
	assert.ok(extracted);
	assert.equal(JSON.parse(extracted).verdict, "PASS");
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(fenced),
		now: NOW,
	});
	assert.equal(result.ran, true);
	assert.equal(result.document?.verdict, "PASS");
});

test("prose prefix then naked json verdict parses", async () => {
	const prefixed = `好的,以下是判词:\n${PASS_JSON}`;
	const extracted = extractJudgeJson(prefixed);
	assert.ok(extracted);
	assert.equal(JSON.parse(extracted).verdict, "PASS");
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(prefixed),
		now: NOW,
	});
	assert.equal(result.ran, true);
	assert.equal(result.document?.verdict, "PASS");
});

test("valid json with misspelled verdict stays rejected", async () => {
	const misspelled = JSON.stringify({
		verdict: "PASSED",
		reasons: [],
		silences: [],
		out_of_scope: [],
		evidence_gaps: [],
		confidence: "high",
	});
	assert.ok(extractJudgeJson(misspelled));
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(misspelled),
		now: NOW,
	});
	assert.equal(result.ran, false);
	assert.match(result.error ?? "", /verdict/);
});

test("prose without json is null and error includes head", async () => {
	const prose = "好的,这任务看起来没问题,建议通过。没有结构化输出。";
	assert.equal(extractJudgeJson(prose), null);
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const tg: string[] = [];
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(prose),
		now: NOW,
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, false);
	assert.match(result.error ?? "", /head:/);
	assert.match(result.error ?? "", /好的,这任务看起来没问题/);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", /accept failed: unusable model response: missing or invalid verdict/);
	assert.equal(/head:/.test(tg[0] ?? ""), false);
});

test("top-level array is rejected", async () => {
	const arrayJson = `[${PASS_JSON}]`;
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(arrayJson),
		now: NOW,
	});
	assert.equal(result.ran, false);
	assert.match(result.error ?? "", /verdict/);
});

test("model JSON missing verdict field fails loud and writes nothing", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(
			JSON.stringify({ reasons: [], silences: [], out_of_scope: [], evidence_gaps: [], confidence: "high" }),
		),
		now: NOW,
	});
	assert.equal(result.ran, false);
	assert.match(result.error ?? "", /verdict/);
	assert.equal(
		await readFile(join(tasksDir(memory), acceptanceJudgeFilename(id)), "utf8").catch(() => "missing"),
		"missing",
	);
});

test("existing verdict is refused without --force", async () => {
	const memory = await tempMemory();
	const id = await writeTask(memory);
	const path = join(tasksDir(memory), acceptanceJudgeFilename(id));
	const previous = {
		verdict: "FIX",
		reasons: ["old"],
		silences: [],
		out_of_scope: [],
		evidence_gaps: [],
		confidence: "low",
		model: "old-model",
		at: "2026-08-01T00:00:00.000Z",
	};
	await writeFile(path, `${JSON.stringify(previous, null, 2)}\n`, "utf8");
	const model = new FakeModel(PASS_JSON);
	const result = await runAcceptanceJudge(memory, id, { model, now: NOW });
	assert.equal(result.ran, false);
	assert.match(result.error ?? "", /--force/);
	assert.equal(model.calls.length, 0);
	assert.equal(JSON.parse(await readFile(path, "utf8")).verdict, "FIX");

	const forced = await runAcceptanceJudge(memory, id, { model, now: NOW, force: true });
	assert.equal(forced.ran, true);
	const disk = JSON.parse(await readFile(path, "utf8")) as { verdict: string; previous?: Array<{ verdict: string }> };
	assert.equal(disk.verdict, "PASS");
	assert.equal(disk.previous?.[0]?.verdict, "FIX");
});

test("judge makes zero writes to worktree and record file", async () => {
	const repo = await tempGitRepo();
	await writeFile(join(repo.root, "src.txt"), "alpha\n", "utf8");
	await git(repo.root, "add", "-A");
	await git(repo.root, "commit", "-q", "-m", "change");
	const memory = await tempMemory();
	const id = await writeTask(memory, {
		worktree: repo.root,
		worktreeBaseSha: repo.baseSha,
		brief: "评分册:改 src.txt\n",
	});
	const reportPath = join(repo.root, ACCEPTANCE_REPORT_FILENAME);
	await writeFile(
		reportPath,
		JSON.stringify({ claims: [{ claim: "green", command: ["true"], exitCode: 0 }] }),
		"utf8",
	);
	const recordPath = join(tasksDir(memory), `${id}.md`);
	const beforeWorktree = await snapshotTree(repo.root);
	const beforeRecord = createHash("sha256")
		.update(await readFile(recordPath))
		.digest("hex");
	const gitLog: string[][] = [];
	const result = await runAcceptanceJudge(memory, id, {
		model: new FakeModel(PASS_JSON),
		now: NOW,
		gitRun: async (cwd, args) => {
			gitLog.push([...args]);
			const { stdout, stderr } = await execFileAsync("git", args, { cwd });
			return { stdout, stderr };
		},
	});
	assert.equal(result.ran, true, result.error);
	const afterWorktree = await snapshotTree(repo.root);
	assert.deepEqual([...afterWorktree.entries()], [...beforeWorktree.entries()]);
	const afterRecord = createHash("sha256")
		.update(await readFile(recordPath))
		.digest("hex");
	assert.equal(afterRecord, beforeRecord);
	const writes = gitLog.filter((args) => {
		const verb = args.find((a) => !a.startsWith("-")) ?? "";
		return /^(add|commit|merge|checkout|reset|clean|push|pull|stash|rebase|cherry-pick|worktree)$/.test(verb);
	});
	assert.deepEqual(writes, []);
});

test("missing task is a usage error with a path", async () => {
	const memory = await tempMemory();
	const { code, stderr } = await runCli(memory, ["accept", "t-missing-nope"]);
	assert.equal(code, 2);
	assert.match(stderr, /t-missing-nope/);
	assert.match(stderr, /\.her[\\/]tasks/);
});

test("judge source path contains no git write verbs", async () => {
	const src = await readFile(new URL("../src/her-core/acceptance-judge.ts", import.meta.url), "utf8");
	assert.equal(/\["(?:add|commit|merge|checkout|reset)"\]/.test(src), false);
});

test("acceptance-officer skill file is appendix B verbatim", async () => {
	const text = await readFile(new URL("../../../.pi/skills/acceptance-officer/SKILL.md", import.meta.url), "utf8");
	const expected = `---
name: acceptance-officer
description: 验收官纪律:怎么收货——对任务书读真 diff、独立复跑、判 PASS/FIX/ESCALATE。触发:验收、收货、审 diff、任务完成要判做没做好、\`her accept\` 判词出来要复核、Fei 问"这包过不过"。
---

# acceptance-officer — 收货不收话

你派出去的每一单,回来都要过你的手。工具 \`her accept <taskId>\` 给你一份判词草稿;**它是你的下属,不是你的免检章**——最终判词是你的。

## 第一公理
**执行方的自述永远只是线索,不是证据。**"全绿了""应该没问题"一个字不采信;你只认:门禁退出码、diff 本身、日志原文、你自己跑出来的输出。

## 收货六步
1. **拿任务书当评分册。** 验收标准在派工前就写死了(六要素模板),收货=逐条核对,不是凭感觉打分。任务书丢了先补一份再收货——没有评分册的验收是聊天。
2. **读真 diff,专扫沉默处。** 不光看它做了什么,专门找"任务书写了、diff 里没有"的条目;规格的沉默处是最大藏身地。
3. **独立复跑关键命令。** 它报绿的命令,你在可信环境亲自重跑;增量判定用失败名单逐名对照(改前改后各跑一遍再 diff 名单),不是看总数。执行方在残缺环境跑出的数字不构成基线。
4. **范围核查。** diff 里出现任务书没授权的改动 = FIX,哪怕那段代码"更好"。顺手清理是违纪不是加分。
5. **诚实性判读。** "跑不了+原因"是加分(诚实);没有证据的"应该能跑"不算绿;门禁绿≠全绿——看清门禁盖住了哪几条,别把 green 读成"全都过了"。
6. **判词三选一,写清理由。** PASS / FIX(点名具体不过处,可热续同一执行方) / ESCALATE(超出你能判的,说清缺什么证据或权限)。拿不准就 ESCALATE;**没证据的 PASS 是事故,不是和气**。

## 取证纪律(判词的地基)
- 要下结论的命令**不挂管道不吞 stderr**:先单独跑拿真退出码,再决定怎么展示。\`| tail\` 会把退出码换成 tail 的。
- **否定式结论要正向证据**:说"零命中"给总数,说"一致"给两边哈希;"没打印东西"不是证据。
- **量具双侧验**:一个门禁/判据,先喂它一个必然该红的输入,见它真红,才配拿它判绿。
- **极端结果先怀疑测量**:全绿满分和全红零分一样,第一嫌疑人都是量具和环境,不是被测对象。

## 合流与落账(收货之后)
- 绿了也不自动合并;合流是显式动作,合并后在集成树重跑关键门禁(worktree 绿不代表集成绿)。
- 共享树上提交只圈自己的 pathspec;别人的未提交改动一个字不代提交。
- 收尾三件套必报:是否 commit、是否 push、验证怎么跑的。
- 判词和证据落档(任务卷宗),让下一个收货的人能复核你。

## 与工具的分工
\`her accept <taskId>\` 干的是重活:装配证据(记录/任务书/日志/门禁/diff)、按本纪律出判词草稿。你干的是拍板:抽查它引用的证据、补它够不着的复跑、签最终判词。它 ESCALATE 或你们判词不一致时,以更严的那个为准,分歧写进落账。

## 唤醒回合反射(G-362)

触发:事件唤醒回合(her-task-wake)列出的终态任务里,有代码派工单(record 带 worker/gates),且 \`.her/tasks/<taskId>.judge.json\` 不在盘上。

第一动作(先于落 episodic):
1. 仓根开庭:\`node packages/her/bin/her.mjs accept <taskId> --json\`(备选:\`node --import tsx packages/her/src/cli.ts accept <taskId> --json\`)。
2. 判官草稿不是免检章——按上文收货流程独立核证(门禁日志/digest/diff/RED 证据),出你的终审判词 PASS / FIX / ESCALATE。
3. 判词与依据落 episodic;FIX/ESCALATE 写清缺什么、下一步给谁。
4. 唤醒回合内不 spawn 新任务(工具层会拒)——返工单写入待办,等下次对话拍板。

判官 CLI 报错→原样记录错误全文并按 ESCALATE 落账;工具坏不是跳过开庭的理由。
`;
	assert.equal(text.replace(/\r\n/g, "\n"), expected.replace(/\r\n/g, "\n"));
});
