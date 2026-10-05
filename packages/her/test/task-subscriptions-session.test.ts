import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { DefaultResourceLoader } from "../../coding-agent/src/core/resource-loader.ts";
import { SettingsManager } from "../../coding-agent/src/core/settings-manager.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import her from "../src/extension.ts";
import { createPendingRecord, saveBgTask, tasksDir } from "../src/her-core/bg-task-record.ts";
import { initStore } from "../src/her-core/index.ts";
import { listTaskSubscriptions } from "../src/task-subscriptions/store.ts";

const execFileAsync = promisify(execFile);

for (const scenario of ["normal", "reload", "retry"] as const) {
	test(`actual AgentSession subscription: ${scenario}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "her-watch-session-"));
		const previousMemory = process.env.HER_MEMORY_DIR;
		let harness: Harness | undefined;
		try {
			process.env.HER_MEMORY_DIR = root;
			await initStore(root);
			await execFileAsync("git", ["init", "--quiet"], { cwd: root });
			await writeFile(
				join(root, ".her", "config.yaml"),
				"tasks:\n  event_wake_poll_seconds: 1\n  budget_daily_cap: 999\n",
			);
			const resourceLoader = new DefaultResourceLoader({
				cwd: root,
				agentDir: join(root, "agent"),
				settingsManager: SettingsManager.inMemory(),
				extensionFactories: [
					(pi) => {
						assert.equal(
							process.env.HER_MEMORY_DIR,
							root,
							"test memory root changed before extension initialization",
						);
						her(pi);
					},
				],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			harness = await createHarness({
				resourceLoader,
				settings: { retry: { enabled: scenario === "retry", maxRetries: 1, baseDelayMs: 1 } },
			});
			await harness.session.bindExtensions({ mode: "tui", shutdownHandler: () => {} });
			harness.session.setActiveToolsByName(["her_task_watch", "her_task_output", "her_task_watch_result"]);
			const task = createPendingRecord({
				objective: "controlled session fixture",
				worker: "test",
				command: ["test"],
				ownerSessionId: harness.sessionManager.getSessionId(),
			});
			task.status = "running";
			await saveBgTask(root, task);
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("her_task_watch", { taskId: task.id, instruction: "完成后读输出并报告" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("已登记订阅"),
			]);
			await harness.session.prompt("订阅这个后台任务，完成后读输出并报告");
			assert.equal((await listTaskSubscriptions(root)).length, 1, JSON.stringify(harness.session.messages));
			if (scenario === "reload") {
				const provider = getApiProvider(harness.faux.api)!;
				await harness.session.reload({
					beforeSessionStart: () => {
						registerApiProvider(provider);
					},
				});
			}
			let wakeTools: string[] = [];
			harness.setResponses([
				...(scenario === "retry"
					? [fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]
					: []),
				() => {
					wakeTools = harness!.session.getActiveToolNames();
					return fauxAssistantMessage(fauxToolCall("her_task_output", { id: task.id }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage(
					fauxToolCall("her_task_watch_result", {
						summary: "SESSION_FIXTURE_OK；仅本地确定性模型验收",
						evidence: ["任务日志 SESSION_FIXTURE_OK"],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("报告已保存"),
			]);
			await writeFile(join(tasksDir(root), `${task.id}.log`), "SESSION_FIXTURE_OK\n");
			await writeFile(join(tasksDir(root), `${task.id}.done`), '{"exitCode":0}\n');
			for (let i = 0; i < 150; i++) {
				if ((await listTaskSubscriptions(root))[0]?.delivery.notifiedAt) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const row = (await listTaskSubscriptions(root))[0];
			assert.ok(!wakeTools.includes("her_task_watch"), "management tools must stay hidden during automatic retry");
			assert.equal(row.delivery.attempts, 1);
			assert.equal(row.state, "completed", JSON.stringify({ row, messages: harness.session.messages }));
			assert.ok(row.delivery.notifiedAt);
			assert.equal(
				harness.sessionManager
					.getEntries()
					.filter(
						(entry) => entry.type === "custom_message" && entry.customType === "her-task-subscription-result",
					).length,
				1,
			);
			assert.equal(harness.getPendingResponseCount(), 0);
			assert.equal(harness.eventsOfType("tool_execution_end").filter((event) => event.isError).length, 0);
		} finally {
			if (harness) {
				await harness.session.abort();
				await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
			}
			if (previousMemory === undefined) delete process.env.HER_MEMORY_DIR;
			else process.env.HER_MEMORY_DIR = previousMemory;
			await rm(root, { recursive: true, force: true });
		}
	});
}
