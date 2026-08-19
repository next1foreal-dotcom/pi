import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import {
	AGENT_TOOL_AUDIT_ORIGIN,
	AGENT_TOOL_WRAPPABLE_V1,
	type AgentMadeToolDecl,
	type AgentToolCallInput,
	createAgentToolRegistry,
	getSessionAgentToolRegistry,
	resetSessionAgentToolRegistryForTest,
} from "../src/her-core/agent-tools.ts";
import { evaluate, policyEnvelope } from "../src/lib/cedar.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

const NOW = "2026-08-19T12:00:00.000Z";
const AUDIT_DAY = "2026-08-19";

function gitStatusDecl(overrides: Partial<AgentMadeToolDecl> = {}): AgentMadeToolDecl {
	const { scope, ...rest } = overrides;
	return {
		name: "git-status",
		wraps: "bash",
		purpose: "read-only git status",
		...rest,
		scope: {
			pathPrefixes: [],
			readOnly: true,
			commandHeads: ["git status"],
			...scope,
		},
	};
}

async function withMemoryDir<T>(fn: (memoryDir: string) => Promise<T>): Promise<T> {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-g284-"));
	try {
		return await fn(memoryDir);
	} finally {
		await rm(memoryDir, { force: true, recursive: true });
	}
}

async function readAudit(memoryDir: string): Promise<Array<Record<string, unknown>>> {
	const raw = await readFile(join(memoryDir, "audit", `${AUDIT_DAY}.jsonl`), "utf8");
	return raw
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function bashCedar(_command: string, anchorPath?: boolean) {
	return evaluate({
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: "bash" },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{
				uid: { type: "Tool", id: "bash" },
				attrs: {
					name: "bash",
					destructive: true,
					...(anchorPath === undefined ? {} : { anchorPath }),
				},
				parents: [],
			},
		],
		...policyEnvelope("default"),
	});
}

test("AGENT_TOOL contract surface is verbatim", () => {
	assert.deepEqual(AGENT_TOOL_WRAPPABLE_V1, ["bash"]);
	assert.equal(AGENT_TOOL_AUDIT_ORIGIN, "agent-made");
});

test("declaring an anchor pathPrefix is wider-than-wrapped and audit-logged", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		const result = registry.register(
			gitStatusDecl({
				name: "wide-soul",
				purpose: "tries to cover an anchor",
				scope: {
					pathPrefixes: ["her-memory/narrative/SOUL.md"],
					readOnly: false,
					commandHeads: ["cat"],
				},
			}),
			{ memoryDir, now: NOW },
		);
		assert.equal(result.ok, false);
		if (result.ok) throw new Error("expected rejection");
		assert.equal(result.reason, "wider-than-wrapped");
		assert.equal(registry.get("wide-soul"), undefined);
		const audit = await readAudit(memoryDir);
		assert.ok(audit.length >= 1);
		const row = audit[0];
		assert.equal(row.verdict, "DENY");
		assert.equal((row.context as { origin?: string }).origin, AGENT_TOOL_AUDIT_ORIGIN);
		assert.equal((row.context as { name?: string }).name, "wide-soul");
		assert.equal(row.rule, "wider-than-wrapped");
	});
});

test("call hitting ANCHOR_PATHS denies with forbid_anchor_write before scope", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		const registered = registry.register(
			gitStatusDecl({
				name: "narrow-cat",
				purpose: "cat project files only",
				scope: {
					pathPrefixes: ["packages/"],
					readOnly: true,
					commandHeads: ["cat"],
				},
			}),
			{ memoryDir, now: NOW },
		);
		assert.equal(registered.ok, true);
		const wrapped: AgentToolCallInput[] = [];
		const call = registry.call(
			"narrow-cat",
			{ command: "cat her-memory/narrative/SOUL.md" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: (wraps, input) => {
					wrapped.push(input);
					assert.equal(wraps, "bash");
					return { ok: true, output: "should-not-run" };
				},
			},
		);
		assert.equal(call.ok, false);
		if (call.ok) throw new Error("expected deny");
		assert.equal(call.reason, "forbid_anchor_write");
		assert.notEqual(call.reason, "scope");
		assert.equal(wrapped.length, 0, "wraps channel must not run after anchor forbid");
		const audit = await readAudit(memoryDir);
		const callRow = audit.find((row) => row.tool === "narrow-cat" && row.verdict === "DENY");
		assert.ok(callRow);
		assert.equal(callRow?.rule, "forbid_anchor_write");
		assert.equal((callRow?.context as { origin?: string }).origin, AGENT_TOOL_AUDIT_ORIGIN);
	});
});

test("a new registry instance does not see tools from another (ephemeral / new process)", async () => {
	await withMemoryDir(async (memoryDir) => {
		const first = createAgentToolRegistry();
		assert.equal(first.register(gitStatusDecl(), { memoryDir, now: NOW }).ok, true);
		assert.ok(first.get("git-status"));
		const second = createAgentToolRegistry();
		assert.equal(second.get("git-status"), undefined);
		const call = second.call(
			"git-status",
			{ command: "git status" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: () => ({ ok: true, output: "ok" }),
			},
		);
		assert.equal(call.ok, false);
	});
});

test("narrow read-only git status can run; audit has origin and matched scope", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		const registered = registry.register(gitStatusDecl(), { memoryDir, now: NOW });
		assert.equal(registered.ok, true);
		const wrapped: Array<{ wraps: string; input: AgentToolCallInput }> = [];
		const call = registry.call(
			"git-status",
			{ command: "git status" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: (wraps, input) => {
					wrapped.push({ wraps, input });
					return { ok: true, output: "On branch feat/g284-agent-tools" };
				},
			},
		);
		assert.equal(call.ok, true);
		if (!call.ok) throw new Error("expected allow");
		assert.equal(call.origin, AGENT_TOOL_AUDIT_ORIGIN);
		assert.equal(call.matchedScope.commandHead, "git status");
		assert.deepEqual(
			wrapped.map((item) => item.wraps),
			["bash"],
		);
		const audit = await readAudit(memoryDir);
		const callRow = audit.find((row) => row.tool === "git-status" && row.verdict === "ALLOW");
		assert.ok(callRow);
		const context = callRow?.context as {
			origin?: string;
			matchedScope?: { commandHead?: string };
			command?: string;
		};
		assert.equal(context.origin, AGENT_TOOL_AUDIT_ORIGIN);
		assert.equal(context.matchedScope?.commandHead, "git status");
		assert.ok(typeof context.command === "string");
	});
});

test("agent-made tool cannot do what bash cannot; execution is the wraps channel", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		assert.equal(registry.register(gitStatusDecl(), { memoryDir, now: NOW }).ok, true);
		assert.deepEqual(resolveGovernedTool("git-status"), { destructive: true, registered: false });

		const bashOnAnchor = bashCedar("cat her-memory/narrative/SOUL.md", true);
		assert.equal(bashOnAnchor.decision, "deny");
		assert.deepEqual(bashOnAnchor.matched, ["forbid_anchor_write"]);

		const wrapped: string[] = [];
		const denied = registry.call(
			"git-status",
			{ command: "cat her-memory/narrative/SOUL.md" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: (wraps) => {
					wrapped.push(wraps);
					return { ok: true, output: "leaked" };
				},
			},
		);
		assert.equal(denied.ok, false);
		if (denied.ok) throw new Error("expected deny");
		assert.equal(denied.reason, "forbid_anchor_write");
		assert.equal(wrapped.length, 0);

		const bashPathless = bashCedar("git status");
		assert.equal(bashPathless.decision, "allow");

		const allowed = registry.call(
			"git-status",
			{ command: "git status" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: (wraps, input) => {
					wrapped.push(`${wraps}:${input.command}`);
					return { ok: true, output: "ok" };
				},
			},
		);
		assert.equal(allowed.ok, true);
		assert.deepEqual(wrapped, ["bash:git status"]);

		const wrapDenied = registry.call(
			"git-status",
			{ command: "git status" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: () => ({ ok: false, reason: "wraps-channel-deny" }),
			},
		);
		assert.equal(wrapDenied.ok, false);
		if (wrapDenied.ok) throw new Error("expected wraps deny to surface");
		assert.equal(wrapDenied.reason, "wraps-channel-deny");
	});
});

test("empty commandHeads and readOnly false is unconstrained / wider-than-wrapped", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		const result = registry.register(
			{
				name: "wide-bash",
				wraps: "bash",
				purpose: "no narrowing",
				scope: { pathPrefixes: [], readOnly: false, commandHeads: [] },
			},
			{ memoryDir, now: NOW },
		);
		assert.equal(result.ok, false);
		if (result.ok) throw new Error("expected rejection");
		assert.equal(result.reason, "wider-than-wrapped");
	});
});

test("not-wrappable, name-taken, and malformed reasons", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		const notWrappable = registry.register(gitStatusDecl({ wraps: "write" }), { memoryDir, now: NOW });
		assert.equal(notWrappable.ok, false);
		if (notWrappable.ok) throw new Error("expected not-wrappable");
		assert.equal(notWrappable.reason, "not-wrappable");

		assert.equal(registry.register(gitStatusDecl(), { memoryDir, now: NOW }).ok, true);
		const taken = registry.register(gitStatusDecl(), { memoryDir, now: NOW });
		assert.equal(taken.ok, false);
		if (taken.ok) throw new Error("expected name-taken");
		assert.equal(taken.reason, "name-taken");

		const malformed = registry.register(gitStatusDecl({ name: "" }), { memoryDir, now: NOW });
		assert.equal(malformed.ok, false);
		if (malformed.ok) throw new Error("expected malformed");
		assert.equal(malformed.reason, "malformed");
	});
});

test("propose writes a Fei-facing text file under proposals/tools and never auto-promotes", async () => {
	await withMemoryDir(async (memoryDir) => {
		const registry = createAgentToolRegistry();
		assert.equal(registry.register(gitStatusDecl(), { memoryDir, now: NOW }).ok, true);
		registry.call(
			"git-status",
			{ command: "git status" },
			{
				cwd: memoryDir,
				memoryDir,
				now: NOW,
				runWrapped: () => ({ ok: true, output: "ok" }),
			},
		);
		const proposed = await registry.propose("git-status", { destRoot: memoryDir });
		assert.equal(proposed.ok, true);
		if (!proposed.ok) throw new Error("expected propose ok");
		assert.equal(proposed.path.replaceAll("\\", "/").endsWith("proposals/tools/git-status.md"), true);
		const text = await readFile(proposed.path, "utf8");
		assert.match(text, /wraps: bash/);
		assert.match(text, /purpose: read-only git status/);
		assert.match(text, /calls: 1/);
		assert.match(text, /git status/);
		assert.match(text, /Fei/);
		assert.match(text, /Never auto-promote/);
		assert.deepEqual(resolveGovernedTool("git-status"), { destructive: true, registered: false });
	});
});

test("CLI agent-tool-propose exports the session registry tool", async () => {
	await withMemoryDir(async (memoryDir) => {
		resetSessionAgentToolRegistryForTest();
		const session = getSessionAgentToolRegistry();
		assert.equal(session.register(gitStatusDecl(), { memoryDir, now: NOW }).ok, true);
		let stdout = "";
		let stderr = "";
		const code = await runHerCli(
			["agent-tool-propose", "git-status"],
			{ ...process.env, HER_MEMORY_DIR: memoryDir },
			memoryDir,
			{
				stderr: {
					write(chunk: string) {
						stderr += chunk;
						return true;
					},
				},
				stdout: {
					write(chunk: string) {
						stdout += chunk;
						return true;
					},
				},
			} as never,
		);
		assert.equal(code, 0, stderr);
		assert.match(stdout, /proposals[\\/]tools[\\/]git-status\.md/);
		resetSessionAgentToolRegistryForTest();
	});
});
