import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/nodejs";
import { evaluate, namedPolicies, policyEnvelope, readPolicyText } from "../src/lib/cedar.ts";

const PLAN_POLICY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"pi-package",
	"policies",
	"her-trust-plan.cedar",
);

function planCall(toolName: string, destructive: boolean): AuthorizationCall {
	return {
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: toolName },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{
				uid: { type: "Tool", id: toolName },
				attrs: { name: toolName, destructive },
				parents: [],
			},
		],
		...policyEnvelope("plan"),
	};
}

test('profile "plan" maps to her-trust-plan.cedar', () => {
	const text = readPolicyText("plan");
	assert.equal(text, readFileSync(PLAN_POLICY, "utf8"));
	assert.deepEqual(Object.keys(namedPolicies("plan")), ["allow_memory_tools", "permit_her_session_send"]);
});

test('HER_CEDAR_PROFILE=plan makes selectedProfile() return "plan"', () => {
	const previous = process.env.HER_CEDAR_PROFILE;
	try {
		process.env.HER_CEDAR_PROFILE = "plan";
		// selectedProfile() is not exported; it is the default argument of
		// namedPolicies / readPolicyText. Env is process-start only in production.
		assert.deepEqual(Object.keys(namedPolicies()), ["allow_memory_tools", "permit_her_session_send"]);
		assert.equal(readPolicyText(), readPolicyText("plan"));
		assert.equal(readPolicyText(), readFileSync(PLAN_POLICY, "utf8"));
	} finally {
		if (previous === undefined) delete process.env.HER_CEDAR_PROFILE;
		else process.env.HER_CEDAR_PROFILE = previous;
	}
});

test("plan Cedar allows non-destructive read tools", () => {
	const verdict = evaluate(planCall("read", false));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("plan Cedar allows her_session_send by its named permit", () => {
	const verdict = evaluate(planCall("her_session_send", true));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["permit_her_session_send"]);
});

test("plan Cedar denies bash (no coding permit)", () => {
	const verdict = evaluate(planCall("bash", true));
	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, []);
});

test("plan Cedar denies write (no coding permit)", () => {
	const verdict = evaluate(planCall("write", true));
	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, []);
});

test("plan Cedar denies her_task_spawn (no spawn permit)", () => {
	const verdict = evaluate(planCall("her_task_spawn", true));
	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, []);
});

test("plan Cedar allows her_ask as non-destructive", () => {
	const verdict = evaluate(planCall("her_ask", false));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});
