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

const CODE =
	'root = Stack([Card("Tasks", [Text("Choose your next task."), Input("note", "Note", $note), Button("Continue", "Continue with my note.", "continue")])])\n$note = ""';

test("real AgentSession emits one durable UI receipt that survives reopening the JSONL session", async (context) => {
	const sessionDirectory = await mkdtemp(join(tmpdir(), "her-intelligent-ui-session-"));
	context.after(() => rm(sessionDirectory, { recursive: true, force: true }));
	// The upstream harness normally chooses in-memory storage. Change only that
	// construction choice, then restore it before any agent or boundary executes.
	const diskFactory = context.mock.method(SessionManager, "inMemory", () =>
		SessionManager.create(sessionDirectory, sessionDirectory),
	);
	let harness: Harness;
	try {
		harness = await createHarness({
			settings: { retry: { enabled: false }, compaction: { enabled: false } },
			extensionFactories: [(pi) => registerIntelligentUiTools(pi)],
		});
	} finally {
		diskFactory.mock.restore();
	}
	const sessionPath = harness.sessionManager.getSessionFile();
	assert.ok(sessionPath);
	assert.equal(harness.sessionManager.isPersisted(), true);
	const wire: JsonAgentSessionEvent[] = [];
	let receiptWasPersistedWhenEmitted = false;
	harness.session.subscribe((event) => {
		// Exercise the actual JSON/RPC projection while mutable partials still have
		// their original shape. No synthetic entry_appended event is injected.
		wire.push(JSON.parse(JSON.stringify(toJsonEvent(event))) as JsonAgentSessionEvent);
		if (event.type === "entry_appended" && event.entry.type === "custom_message") {
			receiptWasPersistedWhenEmitted =
				harness.sessionManager.getEntry(event.entry.id) === event.entry &&
				readFileSync(sessionPath, "utf8").split("\n").includes(JSON.stringify(event.entry));
		}
	});
	try {
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"her_intelligent_ui",
						{ operation: "render", title: "Tasks", code: CODE },
						{ id: "ui-session-1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("The task choices are ready."),
		]);
		await harness.session.prompt("Show my task choices.");

		const receipts = wire.filter(
			(event) =>
				event.type === "entry_appended" &&
				event.entry.type === "custom_message" &&
				event.entry.customType === "her-intelligent-ui",
		);
		assert.equal(receipts.length, 1, "the display message needs a real persisted receipt on the CLI wire");
		const receipt = receipts[0];
		assert.equal(receipt.type, "entry_appended");
		if (receipt.type !== "entry_appended" || receipt.entry.type !== "custom_message")
			assert.fail("missing UI receipt");
		assert.equal(receiptWasPersistedWhenEmitted, true);
		assert.deepEqual(receipt.entry.details, {
			kind: "her-intelligent-ui",
			version: 1,
			uiId: "ui-session-1",
			title: "Tasks",
			code: CODE,
		});
		const branch = harness.sessionManager.getBranch();
		const toolResultIndex = branch.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "ui-session-1",
		);
		const receiptIndex = branch.findIndex((entry) => entry.id === receipt.entry.id);
		assert.ok(
			toolResultIndex >= 0 && receiptIndex > toolResultIndex,
			"the custom message must follow its persisted tool result",
		);
		assert.equal(harness.faux.state.callCount, 2, "UI delivery must not add a steering or follow-up model request");
		assert.equal(harness.eventsOfType("agent_settled").length, 1);
		const reopened = SessionManager.open(sessionPath, sessionDirectory);
		assert.deepEqual(
			reopened.getEntry(receipt.entry.id),
			receipt.entry,
			"reopening the physical session restores the same authoritative UI id, source, and entry id",
		);

		const firstDeltaIndex = wire.findIndex(
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta",
		);
		const toolStartIndex = wire.findIndex((event) => event.type === "tool_execution_start");
		const receiptWireIndex = wire.indexOf(receipt);
		const agentEndIndex = wire.findIndex((event) => event.type === "agent_end");
		assert.ok(firstDeltaIndex >= 0 && firstDeltaIndex < toolStartIndex);
		assert.ok(receiptWireIndex > toolStartIndex && receiptWireIndex < agentEndIndex);
		for (const event of wire) {
			if (event.type !== "message_update") continue;
			assert.equal("message" in event, false);
			assert.equal("partial" in event.assistantMessageEvent, false);
		}

		// Optional local evidence for Studio replay: these are recorded AgentSession
		// events from the faux provider, never a claim of a live Samantha response.
		if (process.env.HER_INTELLIGENT_UI_WIRE_OUTPUT) {
			await writeFile(
				process.env.HER_INTELLIGENT_UI_WIRE_OUTPUT,
				`${wire.map((event) => JSON.stringify(event)).join("\n")}\n`,
				"utf8",
			);
			await writeFile(`${process.env.HER_INTELLIGENT_UI_WIRE_OUTPUT}.session.jsonl`, readFileSync(sessionPath));
		}
	} finally {
		harness.cleanup();
	}
});

test("aborting actual parameter generation cannot produce a persisted UI receipt", async () => {
	const harness = await createHarness({
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		extensionFactories: [(pi) => registerIntelligentUiTools(pi)],
	});
	let argumentsPrefix = "";
	let aborted: Promise<void> | undefined;
	harness.session.subscribe((event) => {
		const wire = toJsonEvent(event);
		if (wire.type !== "message_update" || wire.assistantMessageEvent.type !== "toolcall_delta") return;
		argumentsPrefix += wire.assistantMessageEvent.delta;
		if (!aborted && argumentsPrefix.includes("root = Stack([")) aborted = harness.session.abort();
	});
	try {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("her_intelligent_ui", { code: CODE }, { id: "ui-session-aborted" })], {
				stopReason: "toolUse",
			}),
		]);
		await harness.session.prompt("Show choices, then cancel while they are generated.");
		await aborted;
		assert.ok(aborted, "the real provider stream reached an incomplete root before cancellation");
		assert.equal(harness.eventsOfType("tool_execution_start").length, 0);
		assert.equal(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom_message" && entry.customType === "her-intelligent-ui"),
			false,
		);
		assert.equal(
			harness
				.eventsOfType("entry_appended")
				.some((event) => event.entry.type === "custom_message" && event.entry.customType === "her-intelligent-ui"),
			false,
		);
	} finally {
		harness.cleanup();
	}
});
