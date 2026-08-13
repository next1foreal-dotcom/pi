import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/nodejs";
import { authorizationGateForUsedTools } from "../src/extension.ts";
import { authorizeSelfModTool, evaluate, policyEnvelope } from "../src/lib/cedar.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

function defaultCall(toolName: string, destructive: boolean): AuthorizationCall {
	return {
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: toolName },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{ uid: { type: "Tool", id: toolName }, attrs: { name: toolName, destructive }, parents: [] },
		],
		...policyEnvelope("default"),
	};
}

test("resolveGovernedTool treats unregistered names as destructive", () => {
	assert.deepEqual(resolveGovernedTool("apply_patch"), { destructive: true, registered: false });
	assert.deepEqual(resolveGovernedTool("str_replace"), { destructive: true, registered: false });
	assert.deepEqual(resolveGovernedTool("powershell"), { destructive: true, registered: false });
	assert.deepEqual(resolveGovernedTool("bash"), { destructive: true, registered: true });
	assert.deepEqual(resolveGovernedTool("her_recall"), { destructive: false, registered: true });
});

test("default Cedar still allows bash via permit_coding_destructive_tools", () => {
	const resolved = resolveGovernedTool("bash");
	const verdict = evaluate(defaultCall("bash", resolved.destructive));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["permit_coding_destructive_tools"]);
});

test("default Cedar still allows her_recall via allow_memory_tools", () => {
	const resolved = resolveGovernedTool("her_recall");
	const verdict = evaluate(defaultCall("her_recall", resolved.destructive));
	assert.equal(verdict.decision, "allow");
	assert.deepEqual(verdict.matched, ["allow_memory_tools"]);
});

test("authorizationGateForUsedTools evaluates unregistered tools instead of skipping them", () => {
	const denied = authorizationGateForUsedTools(["apply_patch"]);
	assert.deepEqual(denied, {
		verdict: "DENY",
		gate: "authorize",
		rule: "cedar-deny",
		reason: "tool apply_patch denied by Cedar (cedar-deny)",
	});

	assert.equal(authorizationGateForUsedTools(["her_recall"]), undefined);
	assert.equal(authorizationGateForUsedTools(["bash"]), undefined);
});

test("authorizeSelfModTool denies str_replace and powershell on an anchor path", async (t) => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-failsafe-alias-"));
	t.after(() => rm(memoryDir, { force: true, recursive: true }));
	const now = "2026-08-13T13:00:00.000Z";
	for (const toolName of ["str_replace", "powershell"] as const) {
		const verdict = authorizeSelfModTool({
			cwd: memoryDir,
			memoryDir,
			now,
			targetPath: "her-memory/narrative/SOUL.md",
			toolCallId: `failsafe-${toolName}`,
			toolName,
		});
		assert.equal(verdict.decision, "deny", toolName);
		assert.deepEqual(verdict.matched, ["selfmod_forbid_anchor_write"], toolName);
	}
	const lines = (await readFile(join(memoryDir, "audit", "2026-08-13.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { tool: string; verdict: string });
	assert.deepEqual(
		lines.map((entry) => [entry.tool, entry.verdict]),
		[
			["str_replace", "DENY"],
			["powershell", "DENY"],
		],
	);
});
