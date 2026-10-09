import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	TurnEndEventResult,
} from "@earendil-works/pi-coding-agent";
import { type IntelligentUiToolDeps, registerIntelligentUiTools } from "../src/intelligent-ui/tools.ts";

const SNAPSHOT_ID = "a".repeat(64);
const CODE = `root = Stack([TaskInsights("recent_tasks", "${SNAPSHOT_ID}")])`;
const TITLE = "最近任务的耗时与失败情况";
const ctx = { sessionManager: { getSessionId: () => "pi-session-other-than-workspace" } } as ExtensionContext;

function snapshot() {
	return {
		ok: true,
		kind: "her-background-tasks",
		version: 1,
		workspaceId: "workspace-current",
		snapshotId: SNAPSHOT_ID,
		capturedAt: "2026-10-09T10:00:00.000Z",
		summary: {
			configured: true,
			totalFiles: 3,
			includedRecords: 2,
			excludedRecords: 1,
			limited: false,
			warnings: ["One malformed task record was excluded."],
		},
	};
}

function setup(deps: IntelligentUiToolDeps = {}, context = ctx) {
	let tool: ToolDefinition | undefined;
	const handlers = new Map<string, (event: never, context: ExtensionContext) => unknown>();
	registerIntelligentUiTools(
		{
			registerTool(value: ToolDefinition) {
				tool = value;
			},
			on(name: string, handler: (event: never, context: ExtensionContext) => unknown) {
				handlers.set(name, handler);
			},
		} as unknown as ExtensionAPI,
		{
			workspaceId: "workspace-current",
			resolveUiBase: () => "http://studio.test:4321/",
			fetchImpl: async () => Response.json(snapshot()),
			...deps,
		},
	);
	assert.ok(tool);
	const registered = tool;
	return {
		execute: (params: Record<string, unknown> = { operation: "tasks" }, signal?: AbortSignal) =>
			registered.execute("task-call", params, signal, undefined, context),
		emit: (type: string) => handlers.get(type)?.({ type } as never, context),
		async end(outcome = "completed", isError = false) {
			return (await handlers.get("turn_end")?.(
				{
					type: "turn_end",
					outcome,
					entries: [],
					toolResults: [{ toolName: "her_intelligent_ui", toolCallId: "task-call", isError }],
				} as never,
				context,
			)) as TurnEndEventResult | undefined;
		},
	};
}

test("tasks uses the host workspace endpoint and queues only the deterministic immutable reference", async () => {
	const requests: Array<{ input: string; init?: RequestInit }> = [];
	const harness = setup({
		fetchImpl: async (input, init) => {
			requests.push({ input: String(input), init });
			return Response.json(snapshot());
		},
	});
	const result = await harness.execute();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].input, "http://studio.test:4321/api/conversations/workspace-current/task-insights");
	assert.equal(requests[0].init?.method, "POST");
	assert.equal(requests[0].init?.body, undefined);
	assert.ok(requests[0].init?.signal instanceof AbortSignal);
	assert.deepEqual(result.details, { uiId: "task-call", version: 1, queued: true, snapshot: snapshot() });
	assert.match(JSON.stringify(result.content), /includedRecords/);
	const boundary = await harness.end();
	assert.equal(boundary?.entries?.length, 1);
	assert.deepEqual(boundary?.entries?.[0], {
		type: "custom_message",
		customType: "her-intelligent-ui",
		display: true,
		content: `[交互界面：${TITLE}] — 在 Studio 中查看和操作`,
		details: { kind: "her-intelligent-ui", version: 1, uiId: "task-call", title: TITLE, code: CODE },
	});
	assert.equal(await harness.end(), undefined);
});

test("tasks refuses missing or invalid host workspace ids and never guesses a Pi session id", async () => {
	for (const workspaceId of ["", "../other", "a/b", "a\\b", "a?other", "a\nother", "a".repeat(257)]) {
		let requests = 0;
		const harness = setup({
			workspaceId,
			fetchImpl: async () => {
				requests++;
				return Response.json(snapshot());
			},
		});
		await assert.rejects(harness.execute(), /workspace/i);
		assert.equal(requests, 0);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks refuses model supplied rows, workspace, paths, titles and code", async () => {
	for (const extra of [
		{ workspaceId: "other" },
		{ path: "/private/tasks" },
		{ records: [] },
		{ title: "Invented title" },
		{ code: "root = Text(123)" },
	]) {
		let requests = 0;
		const harness = setup({
			fetchImpl: async () => {
				requests++;
				return Response.json(snapshot());
			},
		});
		await assert.rejects(harness.execute({ operation: "tasks", ...extra }), /only|suppl|parameter/i);
		assert.equal(requests, 0);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks uses HER_WORKSPACE_ID when no test override is provided and omits unrecognized response data", async () => {
	const previous = process.env.HER_WORKSPACE_ID;
	process.env.HER_WORKSPACE_ID = "workspace-current";
	try {
		const harness = setup({
			workspaceId: undefined,
			fetchImpl: async () =>
				Response.json({
					...snapshot(),
					records: [{ invented: 999 }],
					code: "root = Text(999)",
				}),
		});
		const result = await harness.execute();
		assert.deepEqual(result.details, { uiId: "task-call", version: 1, queued: true, snapshot: snapshot() });
		assert.doesNotMatch(JSON.stringify(result.content), /invented|999/);
	} finally {
		if (previous === undefined) delete process.env.HER_WORKSPACE_ID;
		else process.env.HER_WORKSPACE_ID = previous;
	}
});

test("tasks validates the dataset, destination, immutable id, timestamp and coverage fields", async () => {
	const original = snapshot();
	const invalid = [
		{ ...original, ok: false },
		{ ...original, version: 2 },
		{ ...original, kind: "unknown-dataset" },
		{ ...original, workspaceId: "other" },
		{ ...original, snapshotId: "A".repeat(64) },
		{ ...original, snapshotId: 'a")])' },
		{ ...original, capturedAt: "not-a-date" },
		{ ...original, capturedAt: "2026-10-09" },
		{ ...original, summary: undefined },
		{ ...original, summary: { ...original.summary, configured: "true" } },
		{ ...original, summary: { ...original.summary, totalFiles: -1 } },
		{ ...original, summary: { ...original.summary, includedRecords: 1.5 } },
		{ ...original, summary: { ...original.summary, includedRecords: 501 } },
		{ ...original, summary: { ...original.summary, excludedRecords: -1 } },
		{ ...original, summary: { ...original.summary, limited: "yes" } },
		{ ...original, summary: { ...original.summary, warnings: [12] } },
	];
	for (const body of invalid) {
		const harness = setup({ fetchImpl: async () => Response.json(body) });
		await assert.rejects(harness.execute(), /snapshot|task|workspace/i);
		assert.equal(await harness.end(), undefined);
	}
});

test("unconfigured memory is an explicit error while an authentic empty dataset remains usable", async () => {
	const empty = {
		...snapshot(),
		summary: {
			configured: true,
			totalFiles: 0,
			includedRecords: 0,
			excludedRecords: 0,
			limited: false,
			warnings: [],
		},
	};
	const unavailable = setup({
		fetchImpl: async () => Response.json({ ...empty, summary: { ...empty.summary, configured: false } }),
	});
	await assert.rejects(unavailable.execute(), /configur|HER_MEMORY_DIR/i);
	assert.equal(await unavailable.end(), undefined);
	const harness = setup({ fetchImpl: async () => Response.json(empty) });
	await harness.execute();
	assert.equal((await harness.end())?.entries?.length, 1);
});

test("tasks reports unavailable or malformed responses without a successful UI receipt", async () => {
	for (const response of [
		new Response("unavailable", { status: 503 }),
		new Response("not-json"),
		new Response(null),
		Response.json({ ok: false }),
	]) {
		const harness = setup({ fetchImpl: async () => response });
		await assert.rejects(harness.execute(), /task|snapshot/i);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks bounds both advertised response length and actual streamed UTF-8 bytes", async () => {
	for (const response of [
		new Response(JSON.stringify(snapshot()), { headers: { "content-length": "65537" } }),
		new Response(`{"padding":"${"你".repeat(22_000)}"}`),
	]) {
		const harness = setup({ fetchImpl: async () => response });
		await assert.rejects(harness.execute(), /65.?536|large|bytes|limit/i);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks cancellation before and during fetch never queues a card", async () => {
	for (const phase of ["before", "fetch"] as const) {
		const controller = new AbortController();
		let requests = 0;
		const harness = setup({
			fetchImpl: async (_input, init) => {
				requests++;
				controller.abort();
				assert.equal(init?.signal?.aborted, true);
				return Response.json(snapshot());
			},
		});
		if (phase === "before") controller.abort();
		await assert.rejects(harness.execute({ operation: "tasks" }, controller.signal), /abort/i);
		assert.equal(requests, phase === "before" ? 0 : 1);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks abort cancels an in-progress response body, even when the fetch mock ignores the signal", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const harness = setup({
		fetchImpl: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode('{"ok":'));
					},
					pull() {
						controller.abort();
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
	});
	await assert.rejects(harness.execute({ operation: "tasks" }, controller.signal), /abort/i);
	assert.equal(cancelled, true);
	assert.equal(await harness.end(), undefined);
});

test("tasks request timeout is bounded and cannot produce a later successful receipt", async () => {
	const harness = setup({
		requestTimeoutMs: 10,
		fetchImpl: async (_input, init) => {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			assert.equal(init?.signal?.aborted, true);
			return Response.json(snapshot());
		},
	});
	await assert.rejects(harness.execute(), /timeout|abort/i);
	assert.equal(await harness.end(), undefined);
});

test("tasks drafts are discarded after failure, cancellation or a failed tool result", async () => {
	for (const [outcome, isError] of [
		["error", false],
		["aborted", false],
		["completed", true],
	] as const) {
		const harness = setup();
		await harness.execute();
		assert.equal(await harness.end(outcome, isError), undefined);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks cannot enqueue a late source response after its runtime or session branch changes", async () => {
	for (const event of ["session_start", "session_shutdown", "session_tree", "agent_end"]) {
		let respond: ((response: Response) => void) | undefined;
		const harness = setup({
			fetchImpl: () =>
				new Promise<Response>((resolve) => {
					respond = resolve;
				}),
		});
		const request = harness.execute();
		assert.ok(respond);
		harness.emit(event);
		respond(Response.json(snapshot()));
		await assert.rejects(request, /session|interrupt/i);
		assert.equal(await harness.end(), undefined);
	}
});

test("tasks checks an aborted context even when no separate tool signal was supplied", async () => {
	const controller = new AbortController();
	controller.abort();
	let requests = 0;
	const harness = setup(
		{
			fetchImpl: async () => {
				requests++;
				return Response.json(snapshot());
			},
		},
		{ ...ctx, signal: controller.signal },
	);
	await assert.rejects(harness.execute(), /abort/i);
	assert.equal(requests, 0);
	assert.equal(await harness.end(), undefined);
});
