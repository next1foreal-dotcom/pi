import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createDeerAgentFromEnv, FakeDeerAgent, SamanthaAgent } from "../src/her-core/deer-samantha-agent.ts";

test("FakeDeerAgent returns text and schema object", async () => {
	const agent = new FakeDeerAgent();
	const text = await agent.run("hello world");
	assert.match(text, /^fake-agent:/);
	const obj = await agent.run<{ summary: string }>("x", {
		schema: { type: "object", properties: { summary: { type: "string" } } },
	});
	assert.equal(typeof obj.summary, "string");
	const verdict = await agent.run<{ keep: boolean; issues: string[]; note: string }>("verify", {
		schema: {
			type: "object",
			properties: {
				keep: { type: "boolean" },
				issues: { type: "array" },
				note: { type: "string" },
			},
		},
	});
	assert.equal(verdict.keep, true);
	assert.deepEqual(verdict.issues, []);
	assert.match(verdict.note, /fake-verifier/);
});

test("SamanthaAgent builds pi --print argv and parses text field", async () => {
	const calls: { command: string; args: string[]; cwd: string }[] = [];
	const self = fileURLToPath(import.meta.url);
	const real = new SamanthaAgent({
		cliPath: self,
		provider: "deepseek",
		model: "deepseek-v4-flash",
		defaultCwd: "D:/work",
		spawnFn: async (opts) => {
			calls.push({ command: opts.command, args: opts.args, cwd: opts.cwd });
			return {
				exitCode: 0,
				stdout: '{"type":"message","text":"hello from pi"}\n',
				stderr: "",
			};
		},
	});
	const out = await real.run("inspect repo", { cwd: "D:/work", sandbox: "read-only" });
	assert.equal(out, "hello from pi");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.command, process.execPath);
	assert.ok(calls[0]?.args.includes("--print"));
	assert.ok(calls[0]?.args.includes("--mode"));
	assert.ok(calls[0]?.args.includes("json"));
	assert.ok(calls[0]?.args.includes("deepseek"));
	assert.ok(calls[0]?.args.some((a) => a.includes("inspect repo")));
	assert.ok(calls[0]?.args.some((a) => a.includes("read-only")));
});

test("SamanthaAgent schema parse from trailing JSON", async () => {
	const self = fileURLToPath(import.meta.url);
	const agent = new SamanthaAgent({
		cliPath: self,
		spawnFn: async () => ({
			exitCode: 0,
			stdout: 'noise\n{"summary":"ok","sources":["https://example.com"]}\n',
			stderr: "",
		}),
	});
	const out = await agent.run<{ summary: string; sources: string[] }>("q", {
		schema: {
			type: "object",
			properties: { summary: { type: "string" }, sources: { type: "array" } },
			required: ["summary", "sources"],
		},
	});
	assert.equal(out.summary, "ok");
	assert.deepEqual(out.sources, ["https://example.com"]);
});

test("createDeerAgentFromEnv respects HER_DEER_AGENT=fake", () => {
	const agent = createDeerAgentFromEnv({ HER_DEER_AGENT: "fake" });
	assert.ok(agent instanceof FakeDeerAgent);
});

test("createDeerAgentFromEnv rejects unknown", () => {
	assert.throws(() => createDeerAgentFromEnv({ HER_DEER_AGENT: "codex" }), /unknown HER_DEER_AGENT/);
});
