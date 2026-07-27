import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyDeerWorkflowEvent,
	createDeerBridgeState,
	defaultDeerRunId,
	parseDeerWorkflowLine,
} from "../src/her-core/deer-workflow-bridge.ts";

const sampleLines = [
	`{"type":"workflow:start","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","sequence":1,"timestamp":"2026-07-27T05:47:14.257Z"}`,
	`{"type":"workflow:meta","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","meta":{"name":"her-spike-noop","description":"Emits phases without calling an Agent.","phases":[{"title":"Alpha"},{"title":"Beta"}],"exampleArgs":{"note":"spike"}},"sequence":2,"timestamp":"2026-07-27T05:47:14.264Z"}`,
	`{"type":"workflow:phase:start","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","phase":"Alpha","sequence":3,"timestamp":"2026-07-27T05:47:14.264Z"}`,
	`{"type":"log","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","message":"spike note: her-p0","phase":"Alpha","sequence":4,"timestamp":"2026-07-27T05:47:14.264Z"}`,
	`{"type":"workflow:phase:end","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","phase":"Alpha","durationMs":0.077,"sequence":5,"timestamp":"2026-07-27T05:47:14.264Z"}`,
	`{"type":"workflow:phase:start","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","phase":"Beta","sequence":6,"timestamp":"2026-07-27T05:47:14.264Z"}`,
	`{"type":"workflow:end","workflowId":"bdeff03a-16d2-435d-ac13-914c28ca98a8","depth":0,"scriptPath":"D:\\\\@Her\\\\deer-workflow\\\\.tmp-her-spike\\\\workflow.ts","durationMs":7.45,"sequence":9,"timestamp":"2026-07-27T05:47:14.264Z"}`,
];

test("defaultDeerRunId prefixes workflowId", () => {
	assert.equal(defaultDeerRunId("abc"), "deer-abc");
});

test("parseDeerWorkflowLine rejects garbage fail-soft", () => {
	assert.equal(parseDeerWorkflowLine(""), undefined);
	assert.equal(parseDeerWorkflowLine("not-json"), undefined);
	assert.equal((parseDeerWorkflowLine('{"type":"log"}') as { type: string }).type, "log");
});

test("spike JSONL maps to running → phase titles → done", () => {
	let state = createDeerBridgeState({});
	const patches = [];
	for (const line of sampleLines) {
		const raw = parseDeerWorkflowLine(line);
		const result = applyDeerWorkflowEvent(state, raw);
		state = result.state;
		if (result.patch) patches.push(result.patch);
	}
	assert.equal(state.runId, "deer-bdeff03a-16d2-435d-ac13-914c28ca98a8");
	assert.ok(patches.length >= 4);
	assert.equal(patches[0]?.status, "running");
	assert.equal(patches[0]?.kind, "workflow");
	assert.equal(patches[0]?.source, "deer-workflow");
	const meta = patches.find((p) => p.title === "her-spike-noop");
	assert.ok(meta);
	const phase = patches.find((p) => p.title === "her-spike-noop · Alpha");
	assert.ok(phase);
	const done = patches[patches.length - 1];
	assert.equal(done?.status, "done");
	assert.equal(done?.title, "her-spike-noop");
	// log / phase:end must not emit patches
	assert.ok(!patches.some((p) => p.title.includes("spike note")));
});

test("workflow:error → failed with truncated message", () => {
	const state = createDeerBridgeState({ runId: "deer-x", title: "w" });
	const { patch } = applyDeerWorkflowEvent(state, {
		type: "workflow:error",
		workflowId: "x",
		timestamp: "2026-07-27T06:00:00.000Z",
		error: { name: "Error", message: "boom ".repeat(40) },
	});
	assert.equal(patch?.status, "failed");
	assert.ok(patch && patch.title.length <= 160);
	assert.ok(patch?.title.includes("boom"));
});

test("unknown type is ignored", () => {
	const state = createDeerBridgeState({ runId: "deer-1" });
	const result = applyDeerWorkflowEvent(state, { type: "agent:thinking" });
	assert.equal(result.patch, null);
	assert.equal(result.ignoredType, "agent:thinking");
});

test("parentRunId is preserved on patches", () => {
	const state = createDeerBridgeState({ parentRunId: "voice-orchestrator-1", title: "t" });
	const start = applyDeerWorkflowEvent(state, {
		type: "workflow:start",
		workflowId: "w1",
		scriptPath: "/tmp/w.ts",
		timestamp: "2026-07-27T06:00:00.000Z",
	});
	assert.equal(start.patch?.parentRunId, "voice-orchestrator-1");
	assert.equal(start.patch?.runId, "deer-w1");
});
