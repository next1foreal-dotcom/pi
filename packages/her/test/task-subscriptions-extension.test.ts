import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { createPendingRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { initStore } from "../src/her-core/index.ts";
import { listTaskSubscriptions } from "../src/task-subscriptions/store.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
const execFileAsync = promisify(execFile);

test("real extension registration routes a terminal task through idle wake, gated tools, receipt and report", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-watch-extension-"));
	const previousMemory = process.env.HER_MEMORY_DIR;
	const previousProfile = process.env.HER_CEDAR_PROFILE;
	const originalInterval = globalThis.setInterval;
	let poll: (() => void) | undefined;
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const messages: Array<{ customType: string; details?: unknown }> = [];
	const entries: unknown[] = [];
	let activeTools = ["read", "bash"];
	let stale = false;
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerProvider() {},
		unregisterProvider() {},
		appendEntry() {},
		sendMessage(message: { customType: string; details?: unknown }) {
			messages.push(message);
			entries.push({ type: "custom_message", ...message });
		},
		registerCommand() {},
		registerShortcut() {},
		registerFlag() {},
		getFlag() {},
		registerMessageRenderer() {},
		getAllTools: () => [{ name: "read" }, { name: "bash" }, ...[...tools.values()]],
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		events: { on() {}, off() {}, emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		cwd: root,
		hasUI: false,
		ui: { setStatus() {}, notify() {} },
		sessionManager: {
			getSessionId: () => {
				if (stale) throw new Error("This extension ctx is stale after session replacement or reload");
				return "owner";
			},
			getEntries: () => entries,
			getSessionFile: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const tool = (name: string, args: Record<string, unknown>) =>
		tools.get(name)!.execute("fixture-call", args, undefined, undefined, ctx);
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 100; i++) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail("idle delivery did not complete");
	};
	try {
		process.env.HER_MEMORY_DIR = root;
		await initStore(root);
		await execFileAsync("git", ["init", "--quiet"], { cwd: root });
		globalThis.setInterval = ((callback: () => void) => {
			poll = callback;
			return { unref() {} };
		}) as unknown as typeof setInterval;
		her(pi);
		await emit("session_start");
		globalThis.setInterval = originalInterval;
		assert.ok(poll);
		const task = createPendingRecord({
			objective: "fixture task",
			worker: "test",
			command: ["test"],
			ownerSessionId: "owner",
		});
		task.status = "running";
		await saveBgTask(root, task);
		for (const profile of ["heartbeat", "plan"]) {
			process.env.HER_CEDAR_PROFILE = profile;
			await assert.rejects(
				tool("her_task_watch", { taskId: task.id, instruction: "读结果并报告" }),
				/authorized user turn/,
			);
		}
		if (previousProfile === undefined) delete process.env.HER_CEDAR_PROFILE;
		else process.env.HER_CEDAR_PROFILE = previousProfile;
		await tool("her_task_watch", { taskId: task.id, instruction: "读结果并报告" });
		await writeFile(join(tasksDir(root), `${task.id}.done`), '{"exitCode":0}\n');
		poll();
		await waitFor(() => messages.some((message) => message.customType === "her-task-subscription-wake"));
		assert.equal(messages.filter((message) => message.customType === "her-task-wake").length, 0);
		assert.ok(activeTools.includes("her_task_watch_result"));
		assert.ok(!activeTools.includes("bash"));
		const guard = handlers.get("tool_call")![0];
		const blocked = await guard({ toolName: "bash", toolCallId: "blocked", input: { command: "echo no" } }, ctx);
		assert.equal((blocked as { block: boolean }).block, true);
		await tool("her_task_watch_result", {
			summary: "机测任务完成；未进行模型验收",
			evidence: ["fixture task exitCode 0"],
		});
		await emit("agent_end");
		assert.ok(!activeTools.includes("bash"));
		await emit("agent_settled");
		assert.ok(activeTools.includes("bash"));
		poll();
		await waitFor(() => messages.some((message) => message.customType === "her-task-subscription-result"));
		assert.equal((await listTaskSubscriptions(root))[0].state, "completed");
		poll();
		await emit("session_shutdown");
		stale = true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} finally {
		stale = false;
		if (previousProfile === undefined) delete process.env.HER_CEDAR_PROFILE;
		else process.env.HER_CEDAR_PROFILE = previousProfile;
		globalThis.setInterval = originalInterval;
		await emit("session_shutdown");
		if (previousMemory === undefined) delete process.env.HER_MEMORY_DIR;
		else process.env.HER_MEMORY_DIR = previousMemory;
		await rm(root, { recursive: true, force: true });
	}
});
