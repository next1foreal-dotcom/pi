import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "../../coding-agent/src/core/session-manager.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../../coding-agent/src/modes/json-event.ts";
import { createHarness, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { registerIntelligentUiTools } from "../src/intelligent-ui/tools.ts";

const SNAPSHOT_ID = "b".repeat(64);
const WORKSPACE_ID = "task-insights-session";
const SNAPSHOT = {
	ok: true,
	kind: "her-background-tasks",
	version: 1,
	workspaceId: WORKSPACE_ID,
	snapshotId: SNAPSHOT_ID,
	capturedAt: "2026-10-09T10:00:00.000Z",
	summary: { configured: true, totalFiles: 2, includedRecords: 2, excludedRecords: 0, limited: false, warnings: [] },
};

test("real tasks tool preserves the exact snapshot reference through AgentSession and physical JSONL reopen", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "her-task-insights-session-"));
	context.after(() => rm(directory, { recursive: true, force: true }));
	const diskFactory = context.mock.method(SessionManager, "inMemory", () =>
		SessionManager.create(directory, directory),
	);
	const requests: string[] = [];
	let harness: Harness;
	try {
		harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [
				(pi) =>
					registerIntelligentUiTools(pi, {
						workspaceId: WORKSPACE_ID,
						fetchImpl: async (input) => {
							requests.push(String(input));
							return Response.json(SNAPSHOT);
						},
					}),
			],
		});
	} finally {
		diskFactory.mock.restore();
	}
	const path = harness.sessionManager.getSessionFile();
	assert.ok(path);
	const wire: JsonAgentSessionEvent[] = [];
	let persistedAtEmission = false;
	harness.session.subscribe((event) => {
		wire.push(JSON.parse(JSON.stringify(toJsonEvent(event))) as JsonAgentSessionEvent);
		if (event.type === "entry_appended" && event.entry.type === "custom_message") {
			persistedAtEmission = readFileSync(path, "utf8").split("\n").includes(JSON.stringify(event.entry));
		}
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("her_intelligent_ui", { operation: "tasks" }, { id: "tasks-session-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The task snapshot is ready. Adjust the filters in the card."),
		]);
		await harness.session.prompt("Show the duration and failures of my recent tasks.");
		assert.equal(requests.length, 1);
		assert.ok(requests[0].endsWith(`/api/conversations/${WORKSPACE_ID}/task-insights`));
		const entries = harness.sessionManager.getBranch();
		const receipts = entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "her-intelligent-ui",
		);
		assert.equal(receipts.length, 1);
		const receipt = receipts[0];
		if (receipt.type !== "custom_message") assert.fail("missing task UI receipt");
		assert.deepEqual(receipt.details, {
			kind: "her-intelligent-ui",
			version: 1,
			uiId: "tasks-session-1",
			title: "最近任务的耗时与失败情况",
			code: `root = Stack([TaskInsights("recent_tasks", "${SNAPSHOT_ID}")])`,
		});
		assert.equal(persistedAtEmission, true);
		const toolIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "tasks-session-1",
		);
		assert.ok(toolIndex >= 0 && toolIndex < entries.indexOf(receipt));
		assert.deepEqual(SessionManager.open(path, directory).getEntry(receipt.id), receipt);
		assert.equal(harness.faux.state.callCount, 2, "reference delivery must not add a provider turn");
		assert.equal(
			wire.filter((event) => event.type === "entry_appended" && event.entry.type === "custom_message").length,
			1,
		);
		if (process.env.HER_TASK_INSIGHTS_WIRE_OUTPUT) {
			await writeFile(
				process.env.HER_TASK_INSIGHTS_WIRE_OUTPUT,
				`${wire.map((event) => JSON.stringify(event)).join("\n")}\n`,
				"utf8",
			);
			await writeFile(`${process.env.HER_TASK_INSIGHTS_WIRE_OUTPUT}.session.jsonl`, readFileSync(path));
		}
	} finally {
		harness.cleanup();
	}
});

test("an actual failed task-source request leaves no authoritative display entry", async () => {
	let requests = 0;
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		extensionFactories: [
			(pi) =>
				registerIntelligentUiTools(pi, {
					workspaceId: WORKSPACE_ID,
					fetchImpl: async () => {
						requests++;
						return Response.json({ ...SNAPSHOT, workspaceId: "foreign" });
					},
				}),
		],
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("her_intelligent_ui", { operation: "tasks" }, { id: "tasks-rejected" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The source could not be loaded."),
		]);
		await harness.session.prompt("Show recent task failures.");
		assert.equal(requests, 1);
		const entries = harness.sessionManager.getBranch();
		assert.equal(
			entries.some((entry) => entry.type === "custom_message" && entry.customType === "her-intelligent-ui"),
			false,
		);
		assert.equal(
			entries.some(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					entry.message.toolCallId === "tasks-rejected" &&
					entry.message.isError,
			),
			true,
		);
	} finally {
		harness.cleanup();
	}
});
