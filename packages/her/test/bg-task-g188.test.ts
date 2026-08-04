/**
 * G-188 — a session that cannot deliver a wake must not claim one.
 * G-187 — `.her/tasks` sidecars that end in `.md` are not task records.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { canDeliverWake } from "../src/her-core/bg-task-owner.ts";
import { reconcileBgTasks } from "../src/her-core/bg-task-reconcile.ts";
import {
	type BgTaskRecord,
	isTaskRecordFile,
	loadBgTask,
	saveBgTask,
	tasksDir,
} from "../src/her-core/bg-task-record.ts";
import { listBgTasks } from "../src/her-core/bg-task-spawn.ts";

const NOW = new Date("2026-08-02T12:00:00.000Z");

async function memoryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g188-"));
	await mkdir(join(root, ".her", "tasks"), { recursive: true });
	await writeFile(join(root, ".her", "config.yaml"), "tasks:\n  budget_daily_cap: 999\n", "utf8");
	return root;
}

function baseRecord(over: Partial<BgTaskRecord> & { id: string }): BgTaskRecord {
	const { id, ...rest } = over;
	return {
		status: "running",
		objective: "demo",
		worker: "cheap_worker",
		command: [process.execPath, "-e", "console.log(1)"],
		created: "2026-08-02T11:58:00.000Z",
		updated: "2026-08-02T11:58:00.000Z",
		retries: 0,
		host: "THIS-BOX",
		...rest,
		id,
	};
}

/** Seed a finished-but-unannounced task: `.done` on disk, record still running. */
async function seedFinished(root: string, id: string, over: Partial<BgTaskRecord> = {}): Promise<void> {
	await saveBgTask(root, baseRecord({ id, ...over }), "# demo\n");
	await writeFile(join(tasksDir(root), `${id}.done`), '{"exitCode":0}\n', "utf8");
}

test("G-188-1 只有常驻 TUI 会话算「能送达」", () => {
	assert.equal(canDeliverWake("tui"), true);
	assert.equal(canDeliverWake("print"), false);
	assert.equal(canDeliverWake("json"), false);
	assert.equal(canDeliverWake("rpc"), false, "Studio 每条命令起一个 RPC 进程,同样一次性");
	assert.equal(canDeliverWake("something-new"), false, "未知模式按不能送达算 — 等待可恢复,吞不可恢复");
});

// 核心回归: G-148 的活体事故 —— 无主 deer 任务被一次性 CLI 会话认领盖章, 汇报无处可送被吞。
test("G-188-2 一次性会话 reconcile: 0 认领 0 盖章(无主件也不碰)", async () => {
	const root = await memoryRoot();
	await seedFinished(root, "t-20260802-ownerless"); // 无主 —— 正是 G-148 被吞的那一类
	await seedFinished(root, "t-20260802-owned", { ownerSessionId: "session-A" });

	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: NOW,
		sessionId: "one-shot-session",
		deliverable: false,
	});
	assert.deepEqual(events, [], "一次性会话不许产出它送不掉的事件");

	for (const id of ["t-20260802-ownerless", "t-20260802-owned"]) {
		const rec = (await loadBgTask(root, id))?.record;
		assert.equal(rec?.status, "completed", `${id}: 状态照常推进`);
		assert.equal(rec?.notifiedAt, undefined, `${id}: 章一个都不许盖`);
		assert.equal(rec?.lockedBy, undefined, `${id}: 不留租约脏数据`);
	}
});

test("G-188-3 常驻会话随后照常认领(等待是可恢复的)", async () => {
	const root = await memoryRoot();
	await seedFinished(root, "t-20260802-ownerless");
	await seedFinished(root, "t-20260802-owned", { ownerSessionId: "session-A" });

	// 一次性会话先扫一遍 —— 什么都不该被它吃掉
	await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "one-shot", deliverable: false });

	// 常驻会话 A 接手: 自己的 + 无主的都归它
	const events = await reconcileBgTasks(root, {
		hostname: "THIS-BOX",
		now: NOW,
		sessionId: "session-A",
		deliverable: true,
	});
	assert.deepEqual(events.map((e) => e.taskId).sort(), ["t-20260802-owned", "t-20260802-ownerless"]);
	for (const id of ["t-20260802-ownerless", "t-20260802-owned"]) {
		assert.ok((await loadBgTask(root, id))?.record.notifiedAt, `${id}: 认领时才盖章`);
	}
});

test("G-188-4 deliverable 缺省 = 老行为(不写这个字段的调用方零变化)", async () => {
	const root = await memoryRoot();
	await seedFinished(root, "t-20260802-legacy");
	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW });
	assert.equal(events.length, 1);
});

// G-187 — codex 的 --output-last-message 把 <id>.result.md 写进同一个目录,
// 按 *.md 扫描会把它当成任务记录 → parseBgTaskMarkdown 抛错 → 整趟 reconcile 死。
// 实弹血证: 2026-08-02 一份 result.md 让 reconcile 抛 "command must be a string array",
// 而同一趟里已经盖过章的任务事件随之丢失。
test("G-187-1 isTaskRecordFile 认记录不认 sidecar", () => {
	assert.equal(isTaskRecordFile("t-20260802-abc123.md"), true);
	assert.equal(isTaskRecordFile("t-20260802-abc123.result.md"), false);
	assert.equal(isTaskRecordFile("t-20260802-abc123.log"), false);
	assert.equal(isTaskRecordFile("t-20260802-abc123.done"), false);
	assert.equal(isTaskRecordFile(".md"), false);
});

test("G-187-2 result.md sidecar 不再毒死整趟 reconcile / listBgTasks", async () => {
	const root = await memoryRoot();
	await seedFinished(root, "t-20260802-codex", { worker: "codex" });
	// codex -o 落下的真实形状: 同目录、同前缀、.md 结尾、内容根本不是 frontmatter
	await writeFile(join(tasksDir(root), "t-20260802-codex.result.md"), "ok\n", "utf8");

	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "resident" });
	assert.equal(events.length, 1, "sidecar 必须被跳过,而不是把整趟扫描炸掉");
	assert.equal(events[0]?.taskId, "t-20260802-codex");

	const listed = await listBgTasks(root, { hostname: "THIS-BOX" });
	assert.deepEqual(
		listed.map((t) => t.id),
		["t-20260802-codex"],
		"listBgTasks(并发闸走这条路)同样不许被 sidecar 毒死",
	);
});

test("G-187-3 一份坏记录不再连累同趟的其它任务", async () => {
	const root = await memoryRoot();
	await seedFinished(root, "t-20260802-good");
	// 半截写入/损坏的记录: 文件名合法, 内容解析不了
	await writeFile(join(tasksDir(root), "t-20260802-corrupt.md"), "---\nid: t-20260802-corrupt\n---\n", "utf8");

	const events = await reconcileBgTasks(root, { hostname: "THIS-BOX", now: NOW, sessionId: "resident" });
	assert.deepEqual(
		events.map((e) => e.taskId),
		["t-20260802-good"],
		"坏记录跳过并留 warn,好记录照常认领",
	);
});

// G-187 腿2 — continue 的四道前置(C2 的错误语义),零成本可验: 全部在 spawn 之前抛。
test("G-187-4 continueBgTask 的拒绝语义", async () => {
	const root = await memoryRoot();
	const { continueBgTask } = await import("../src/her-core/bg-task-spawn.ts");

	await assert.rejects(() => continueBgTask(root, "t-nope", "hi", "s1"), /原任务不存在/);

	await saveBgTask(root, baseRecord({ id: "t-running", worker: "codex" }), "# x\n");
	await assert.rejects(() => continueBgTask(root, "t-running", "hi", "s1"), /未处于终态/);

	await saveBgTask(root, baseRecord({ id: "t-nosid", status: "completed", worker: "codex" }), "# x\n");
	await assert.rejects(() => continueBgTask(root, "t-nosid", "hi", "s1"), /没有 codexSessionId/);

	// 非 codex 任务: 注意 C2 的判定顺序是 codexSessionId 先于 worker,所以一个既非 codex
	// 又没有 session id 的任务报的是前者。带上 codexSessionId 才能走到 worker 那道。
	await saveBgTask(
		root,
		baseRecord({ id: "t-notcodex", status: "completed", worker: "claude", codexSessionId: "sid-1" }),
		"# x\n",
	);
	await assert.rejects(() => continueBgTask(root, "t-notcodex", "hi", "s1"), /任务类型不是 codex/);
});

// G-187 ①②③ — 续跑必须带着父任务的档和权限走,而且续了还能再续。
test("G-187-5 buildCodexResumeCommand 继承 profile 旗子,且旗子在 resume 之前", async () => {
	const { buildCodexResumeCommand, prepareWorkerCommand } = await import("../src/her-core/worker-profile.ts");
	const profileArgv = [
		"codex",
		"exec",
		"--sandbox",
		"workspace-write",
		"-m",
		"gpt-5.6-terra",
		"-c",
		"model_reasoning_effort=medium",
		"-",
	];

	const resume = buildCodexResumeCommand(profileArgv, "sid-1", "暗号是什么?");
	assert.deepEqual(resume, [
		"codex",
		"exec",
		"--sandbox",
		"workspace-write",
		"-m",
		"gpt-5.6-terra",
		"-c",
		"model_reasoning_effort=medium",
		"resume",
		"sid-1",
		"暗号是什么?",
	]);
	// 父任务的档与权限逐个带过来了
	assert.ok(resume.includes("workspace-write"), "续跑不许丢写权限");
	assert.ok(resume.includes("gpt-5.6-terra"), "续跑不许换模型");
	assert.ok(resume.includes("model_reasoning_effort=medium"), "续跑不许换 effort 档");
	// stdin 占位符必须去掉: resume 的 prompt 走参数不走 stdin
	assert.equal(resume.includes("-"), false);

	// 顺序合法性: 旗子必须都在 resume 之前(codex 拒绝位置参数之后的旗子)
	const prepared = prepareWorkerCommand("codex", { argv: resume }, "C:\tasks", "t-child");
	const resumeAt = prepared.indexOf("resume");
	for (const flag of ["--sandbox", "-m", "-c", "--json", "-o", "--skip-git-repo-check"]) {
		const at = prepared.indexOf(flag);
		assert.ok(at >= 0, `${flag} 应在续跑命令里`);
		assert.ok(at < resumeAt, `${flag} 必须排在 resume 之前(实测 codex 不收后置旗子)`);
	}
	// 子任务拿到的是自己的 result.md,不是父任务的
	assert.ok(prepared.includes(join("C:\tasks", "t-child.result.md")));

	// 幂等: 再跑一次不重复注入
	assert.deepEqual(prepareWorkerCommand("codex", { argv: prepared }, "C:\tasks", "t-child"), prepared);
});

test("G-187-6 bare-command 的 codex 续跑也拿到 --json/-o(否则续完不能再续)", async () => {
	const root = await memoryRoot();
	await writeFile(
		join(root, ".her", "config.yaml"),
		[
			"tasks:",
			"  budget_daily_cap: 999",
			"  default_worker: codex",
			"workers:",
			"  codex:",
			'    argv: ["codex", "exec", "--sandbox", "workspace-write", "-"]',
			"",
		].join("\n"),
		"utf8",
	);
	const { continueBgTask } = await import("../src/her-core/bg-task-spawn.ts");
	await saveBgTask(
		root,
		baseRecord({ id: "t-parent", status: "completed", worker: "codex", codexSessionId: "sid-parent" }),
		"# x\n",
	);

	// 真起进程会调 codex; 这里只验证落盘的 argv 形状 —— 命令本身会失败, 记录照样写下来。
	const spawned = await continueBgTask(root, "t-parent", "暗号是什么?", "session-X").catch(() => undefined);
	const childId = spawned && spawned.status === "running" ? spawned.id : undefined;
	const child = childId ? (await loadBgTask(root, childId))?.record : undefined;
	if (!child) return; // 环境里没有 codex 可执行文件时跳过(argv 形状由 G-187-5 覆盖)
	assert.equal(child.parentTask, "t-parent");
	assert.equal(child.ownerSessionId, "session-X");
	assert.ok(child.command.includes("--json"), "续跑子任务必须带 --json 才能捕到自己的 session id");
	assert.ok(
		child.command.some((a) => a.endsWith(`${childId}.result.md`)),
		"续跑子任务必须写自己的 result.md",
	);
	assert.ok(child.command.indexOf("--json") < child.command.indexOf("resume"), "旗子必须在 resume 之前");
});

// 反向红线: 普通 bare 命令(worker 落到默认值 codex)绝不能被塞 codex 旗子。
test("G-187-7 非 codex 的 bare 命令不被注入 codex 旗子", async () => {
	const root = await memoryRoot();
	await writeFile(
		join(root, ".her", "config.yaml"),
		["tasks:", "  budget_daily_cap: 999", "  default_worker: codex", ""].join("\n"),
		"utf8",
	);
	const { spawnBgTask, stopBgTask } = await import("../src/her-core/bg-task-spawn.ts");
	const r = await spawnBgTask(root, {
		objective: "plain node",
		command: [process.execPath, "-e", "setTimeout(()=>{},20000)"],
		skipGates: true,
		heartbeatMs: 2000,
	});
	assert.equal(r.status, "running");
	if (r.status !== "running") return;
	const rec = (await loadBgTask(root, r.id))?.record;
	assert.equal(rec?.worker, "codex", "worker 确实落到了默认值 —— 正是这条路径的陷阱");
	assert.equal(rec?.command.includes("--json"), false, "但 argv[0] 不是 codex, 就绝不许注入");
	assert.equal(rec?.command.includes("--skip-git-repo-check"), false);
	await stopBgTask(root, r.id);
	await sleep(50);
});
