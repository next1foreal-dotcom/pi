import assert from "node:assert/strict";
import test from "node:test";
import type {
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	TurnEndEvent,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	buildIntelligentUiMessage,
	INTELLIGENT_UI_CODE_MAX_BYTES,
	INTELLIGENT_UI_TITLE_MAX,
} from "../src/intelligent-ui/message.ts";
import { type IntelligentUiToolDeps, registerIntelligentUiTools } from "../src/intelligent-ui/tools.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";
import { capabilityCategory } from "../src/tool-disclosure.ts";

const CODE = 'root = Stack([Text("Hello")])';

type SentMessage = { customType: string; content: string; display: boolean; details: unknown };

function context(sessionId = "session-1", signal?: AbortSignal): ExtensionContext {
	return { sessionManager: { getSessionId: () => sessionId }, signal } as ExtensionContext;
}

function turnEnd(ids = ["call-42"], overrides: Partial<TurnEndEvent> = {}): TurnEndEvent {
	return {
		type: "turn_end",
		outcome: "completed",
		entries: [],
		toolResults: ids.map((toolCallId) => ({
			role: "toolResult",
			toolCallId,
			toolName: "her_intelligent_ui",
			content: [{ type: "text", text: "queued" }],
			isError: false,
			timestamp: 0,
		})),
		...overrides,
	} as TurnEndEvent;
}

function collectTool(deps: IntelligentUiToolDeps = {}) {
	let tool: ToolDefinition | undefined;
	const messages: SentMessage[] = [];
	const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
	const pi = {
		registerTool(definition: ToolDefinition) {
			assert.equal(tool, undefined, "only one catalog/render tool is registered");
			tool = definition;
		},
		sendMessage(message: SentMessage) {
			messages.push(message);
		},
		on(event: string, handler: (event: never, ctx: ExtensionContext) => unknown) {
			assert.equal(handlers.has(event), false);
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
	} as unknown as ExtensionAPI;
	registerIntelligentUiTools(pi, deps);
	assert.ok(tool);
	return {
		tool,
		messages,
		async emit(event: { type: string }, ctx = context()) {
			return (await handlers.get(event.type)?.(event as never, ctx)) as TurnEndEventResult | undefined;
		},
	};
}

function execute(
	tool: ToolDefinition,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	toolCallId = "call-42",
	ctx = context(),
) {
	return tool.execute(toolCallId, params, signal, undefined, ctx);
}

test("render message preserves source, uses the tool call id and has a readable fallback", () => {
	const message = buildIntelligentUiMessage("call-42", { title: "  记忆搜索  ", code: CODE });
	assert.deepEqual(message.details, {
		kind: "her-intelligent-ui",
		version: 1,
		uiId: "call-42",
		title: "记忆搜索",
		code: CODE,
	});
	assert.ok(message.content.trim());
	assert.match(message.content, /记忆搜索/);
	assert.equal(buildIntelligentUiMessage("call-1", { code: CODE }).details.title, "交互界面");
});

test("render rejects missing code, invalid title, empty ids and non-root-first programs", () => {
	for (const code of [undefined, null, 42, "", " \n "]) {
		assert.throws(() => buildIntelligentUiMessage("call-42", { code }), /code/);
	}
	for (const title of [null, 42, " ", "x".repeat(INTELLIGENT_UI_TITLE_MAX + 1)]) {
		assert.throws(() => buildIntelligentUiMessage("call-42", { code: CODE, title }), /title/);
	}
	assert.throws(() => buildIntelligentUiMessage("", { code: CODE }), /uiId/);
	assert.throws(() => buildIntelligentUiMessage("call-42", { code: 'child = Text("Hi")\nroot = child' }), /root/);
});

test("render bounds UTF-8 bytes rather than just character count", () => {
	const code = `root = Text("${"你".repeat(Math.ceil(INTELLIGENT_UI_CODE_MAX_BYTES / 3))}")`;
	assert.ok(code.length < INTELLIGENT_UI_CODE_MAX_BYTES);
	assert.throws(() => buildIntelligentUiMessage("call-42", { code }), /bytes/);
});

test("shared protocol accepts 160-character titles and bounds opaque UI ids without control characters", () => {
	assert.equal(
		buildIntelligentUiMessage("x".repeat(256), { title: "x".repeat(160), code: CODE }).details.title.length,
		160,
	);
	for (const uiId of ["x".repeat(257), "call\n42", "call\u000042", "call\u007f42"]) {
		assert.throws(() => buildIntelligentUiMessage(uiId, { code: CODE }), /uiId/);
	}
});

test("render queues locally, then one successful turn boundary returns the authoritative display draft", async () => {
	const { tool, messages, emit } = collectTool({
		fetchImpl: async () => {
			throw new Error("render must not fetch");
		},
	});
	assert.equal(tool.name, "her_intelligent_ui");
	const result = await execute(tool, { title: "状态", code: CODE });
	assert.deepEqual(result.details, { uiId: "call-42", version: 1, queued: true });
	assert.equal(messages.length, 0, "sendMessage would steer and does not emit the required durable entry event");
	const boundary = await emit(turnEnd());
	assert.deepEqual(boundary?.entries, [
		{
			type: "custom_message",
			customType: "her-intelligent-ui",
			display: true,
			...buildIntelligentUiMessage("call-42", { title: "状态", code: CODE }),
		},
	]);
	assert.equal(boundary?.continue, undefined, "render does not request another provider call");
	assert.equal(await emit(turnEnd()), undefined, "a render is consumed exactly once");
});

test("multiple cards retain tool-result order and preserve drafts from earlier boundary handlers", async () => {
	const { tool, emit } = collectTool();
	await execute(tool, { title: "Second", code: CODE }, undefined, "call-2");
	await execute(tool, { title: "First", code: CODE }, undefined, "call-1");
	const earlier: CustomMessageEntryDraft = {
		type: "custom_message",
		customType: "other",
		display: false,
		content: "context",
	};
	const boundary = await emit(turnEnd(["call-1", "call-2"], { entries: [earlier] }));
	assert.equal(boundary?.entries?.[0], earlier);
	assert.deepEqual(
		boundary?.entries?.slice(1).map((entry) => (entry as CustomMessageEntryDraft).details),
		[
			buildIntelligentUiMessage("call-1", { title: "First", code: CODE }).details,
			buildIntelligentUiMessage("call-2", { title: "Second", code: CODE }).details,
		],
	);
});

test("aborted, failed, and unmatched renders cannot be committed by a later turn", async () => {
	for (const scenario of ["signal", "context-signal", "error", "aborted", "failed-tool", "missing-tool"] as const) {
		const { tool, emit } = collectTool();
		const controller = new AbortController();
		await execute(tool, { code: CODE }, scenario === "signal" ? controller.signal : undefined);
		controller.abort();
		const event = turnEnd();
		if (scenario === "error" || scenario === "aborted") event.outcome = scenario;
		if (scenario === "failed-tool") event.toolResults[0].isError = true;
		if (scenario === "missing-tool") event.toolResults = [];
		assert.equal(
			await emit(event, context("session-1", scenario === "context-signal" ? controller.signal : undefined)),
			undefined,
			scenario,
		);
		assert.equal(await emit(turnEnd()), undefined, `${scenario}: discarded drafts must not leak`);
	}
});

test("pending cards stay within their session and are discarded on runtime or branch changes", async () => {
	const { tool, emit } = collectTool();
	await execute(tool, { code: CODE });
	assert.equal(await emit(turnEnd(), context("session-2")), undefined);
	await emit({ type: "session_start" }, context("session-2"));
	assert.equal(await emit(turnEnd()), undefined);
	for (const type of ["agent_end", "session_shutdown", "session_tree"]) {
		await execute(tool, { code: CODE });
		await emit({ type });
		assert.equal(await emit(turnEnd()), undefined, type);
	}
});

test("rejected or cancelled render never emits a final message", async () => {
	const { tool, messages } = collectTool();
	await assert.rejects(execute(tool, { operation: "render", code: "" }), /code/);
	await assert.rejects(execute(tool, { operation: "publish", code: CODE }), /operation/);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(execute(tool, { code: CODE }, controller.signal), /abort/i);
	assert.equal(messages.length, 0);
});

test("catalog reads the configured Studio endpoint and forwards the live component contract", async () => {
	const requests: Array<{ url: string; method: string }> = [];
	const catalog = {
		ok: true,
		version: 1,
		spec: { root: "Stack", components: { Text: { props: ["content"] } } },
		systemPrompt: "root must be first; actions are read-only; continue includes current state",
	};
	const { tool, messages } = collectTool({
		resolveUiBase: () => "http://studio.test:5510/",
		fetchImpl: async (input, init) => {
			requests.push({ url: String(input), method: init?.method ?? "GET" });
			return new Response(JSON.stringify(catalog), { headers: { "content-type": "application/json" } });
		},
	});
	const result = await execute(tool, { operation: "catalog" });
	assert.deepEqual(requests, [{ url: "http://studio.test:5510/api/her/intelligent-ui/catalog", method: "GET" }]);
	assert.deepEqual(result.details, catalog);
	assert.match(JSON.stringify(result.content), /Text/);
	assert.match(JSON.stringify(result.content), /read-only/);
	assert.match(JSON.stringify(result.content), /continue/);
	assert.equal(messages.length, 0);
});

test("catalog reports HTTP, malformed and denied responses instead of rendering a success", async () => {
	for (const response of [
		new Response("unavailable", { status: 503 }),
		new Response("not-json", { status: 200 }),
		new Response(JSON.stringify({ ok: false, error: "catalog unavailable" })),
		new Response(JSON.stringify({ ok: true })),
		new Response(
			JSON.stringify({ ok: true, version: 1, spec: { root: "Stack", components: {} }, systemPrompt: " " }),
		),
	]) {
		const { tool, messages } = collectTool({ fetchImpl: async () => response });
		await assert.rejects(execute(tool, { operation: "catalog" }), /catalog/i);
		assert.equal(messages.length, 0);
	}
});

test("new tool is explicitly governed as display-only and is discoverable as a UI integration", () => {
	assert.deepEqual(resolveGovernedTool("her_intelligent_ui"), { destructive: false, registered: true });
	assert.equal(capabilityCategory("her_intelligent_ui"), "integration");
	assert.deepEqual(resolveGovernedTool("her_act"), { destructive: true, registered: true });
});
