import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/nodejs";
import { evaluate, namedPolicies, policyEnvelope, readPolicyText } from "../src/lib/cedar.ts";

const FULL_POLICY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"pi-package",
	"policies",
	"her-trust-full.cedar",
);

function toolCall(profile: "full" | "plan", toolName: string, destructive: boolean): AuthorizationCall {
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
		...policyEnvelope(profile),
	};
}

test('profile "full" maps to her-trust-full.cedar', () => {
	const text = readPolicyText("full");
	assert.equal(text, readFileSync(FULL_POLICY, "utf8"));
	assert.deepEqual(Object.keys(namedPolicies("full")), ["allow_memory_tools", "forbid_anchor_write"]);
});

test('HER_CEDAR_PROFILE=full makes selectedProfile() return "full"', () => {
	const previous = process.env.HER_CEDAR_PROFILE;
	try {
		process.env.HER_CEDAR_PROFILE = "full";
		// selectedProfile() is not exported; it is the default argument of
		// namedPolicies / readPolicyText. Env is process-start only in production.
		assert.deepEqual(Object.keys(namedPolicies()), ["allow_memory_tools", "forbid_anchor_write"]);
		assert.equal(readPolicyText(), readPolicyText("full"));
		assert.equal(readPolicyText(), readFileSync(FULL_POLICY, "utf8"));
	} finally {
		if (previous === undefined) delete process.env.HER_CEDAR_PROFILE;
		else process.env.HER_CEDAR_PROFILE = previous;
	}
});

test("full Cedar allows bash", () => {
	const verdict = evaluate(toolCall("full", "bash", true));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("full Cedar allows write", () => {
	const verdict = evaluate(toolCall("full", "write", true));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("full Cedar allows her_task_spawn", () => {
	const verdict = evaluate(toolCall("full", "her_task_spawn", true));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("full Cedar allows non-destructive read tools", () => {
	const verdict = evaluate(toolCall("full", "read", false));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("plan Cedar still denies bash after full profile is added", () => {
	const verdict = evaluate(toolCall("plan", "bash", true));
	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, []);
});
