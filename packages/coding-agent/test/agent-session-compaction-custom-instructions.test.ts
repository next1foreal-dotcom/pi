import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const FOCUS = "G402-FOCUS-MARKER: keep the user's exact wording";

type SessionWithAutoCompaction = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function summarizerPrompt(context: Context): string {
	const first = context.messages[0];
	assert.ok(first, "summarizer should receive a user message");
	assert.equal(first.role, "user");
	if (typeof first.content === "string") {
		return first.content;
	}
	const textBlock = first.content.find((block) => block.type === "text");
	assert.ok(textBlock && textBlock.type === "text", "summarizer user message should have text");
	return textBlock.text;
}

function appendTurn(harness: Harness, userText: string, assistantText: string, timestamp: number): void {
	const model = harness.session.model!;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: userText }],
		timestamp,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: assistantText }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: timestamp + 500,
	});
}

async function seedCompactableSession(customInstructions?: string): Promise<Harness> {
	const harness = await createHarness({
		settings: {
			compaction: {
				keepRecentTokens: 1,
				...(customInstructions !== undefined ? { customInstructions } : {}),
			},
		},
		responses: ["compacted"],
	});
	const now = 1_700_000_000_000;
	appendTurn(harness, "first message to compact", "first assistant response to compact", now - 4000);
	appendTurn(harness, "second message to compact", "second assistant response to compact", now - 1000);
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

async function autoCompactionPrompt(harness: Harness): Promise<string> {
	await (harness.session as unknown as SessionWithAutoCompaction)._runAutoCompaction("threshold", false);
	const ended = harness.eventsOfType("compaction_end");
	assert.equal(ended.length, 1, "auto-compaction should emit compaction_end");
	assert.ok(ended[0].result, "auto-compaction should produce a summary");
	assert.equal(ended[0].aborted, false);
	assert.ok(harness.faux.contexts.length > 0, "summarizer streamFn should be called");
	const prompts = harness.faux.contexts.map(summarizerPrompt);
	const checkpoint = prompts.find((prompt) => prompt.includes("Create a structured context checkpoint summary"));
	assert.ok(checkpoint, "history summarizer should use the structured checkpoint prompt");
	return checkpoint;
}

test("getCompactionSettings returns customInstructions from project settings.json", async () => {
	const root = await mkdtemp(join(tmpdir(), "g402-compaction-settings-"));
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(projectDir, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(projectDir, ".pi", "settings.json"),
		JSON.stringify({ compaction: { customInstructions: FOCUS } }, null, 2),
		"utf8",
	);

	const manager = SettingsManager.create(projectDir, agentDir);
	assert.equal(manager.getCompactionSettings().customInstructions, FOCUS);
});

test("getCompactionSettings omits customInstructions when unset", () => {
	const manager = SettingsManager.inMemory();
	assert.equal(manager.getCompactionSettings().customInstructions, undefined);
});

test("auto-compaction prompt includes CompactionSettings.customInstructions", async () => {
	const harness = await seedCompactableSession(FOCUS);
	try {
		const prompt = await autoCompactionPrompt(harness);
		assert.ok(
			prompt.includes(`Additional focus: ${FOCUS}`),
			"prompt should append Additional focus with the setting text",
		);
		assert.ok(prompt.includes(FOCUS));
	} finally {
		harness.cleanup();
	}
});

test("auto-compaction prompt is byte-identical to the unset path when customInstructions is absent", async () => {
	const defaultHarness = await seedCompactableSession();
	const customHarness = await seedCompactableSession(FOCUS);
	try {
		const defaultPrompt = await autoCompactionPrompt(defaultHarness);
		const customPrompt = await autoCompactionPrompt(customHarness);
		assert.equal(defaultPrompt.includes("Additional focus:"), false);
		assert.equal(customPrompt, `${defaultPrompt}\n\nAdditional focus: ${FOCUS}`);
	} finally {
		defaultHarness.cleanup();
		customHarness.cleanup();
	}
});
