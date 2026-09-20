import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, readText, writeText } from "../src/her-core/index.ts";
import { StorePaths } from "../src/her-core/paths.ts";
import { observeReflexShadow, parseReflexConfig } from "../src/her-core/reflex.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-reflex-"));
	await initStore(root);
	return root;
}

function reflexConfig(extra = ""): string {
	return [
		"reflex:",
		"  enabled: true",
		"  shadow: true",
		"  provider: typesafe",
		"  base_url: https://api.typesafe.ai",
		"  model: jev-latest",
		"  api_key_env: TYPESAFE_API_KEY",
		"  allow_external_state: true",
		"  timeout_ms: 2500",
		extra,
		"",
	].join("\n");
}

function responseBody(): string {
	return JSON.stringify({
		model: "jev-latest",
		answers: {
			goal_relevance: { type: "noul", noul: 0.91 },
			novelty: { type: "noul", noul: 0.64 },
			urgency: { type: "noul", noul: 0.22 },
			contradiction: { type: "noul", noul: 0.11 },
			personal_significance: { type: "noul", noul: 0.78 },
			recall_needed: { type: "noul", noul: 0.88 },
			wake_system2: { type: "noul", noul: 0.31 },
			interrupt_user: { type: "noul", noul: 0.08 },
		},
		usage: { input_tokens: 120, output_tokens: 16 },
	});
}

test("parseReflexConfig reads only the reflex section and stays disabled by default", () => {
	assert.equal(parseReflexConfig("llm:\n  model_fast: x\n").enabled, false);
	const parsed = parseReflexConfig(reflexConfig());
	assert.deepEqual(parsed, {
		enabled: true,
		shadow: true,
		provider: "typesafe",
		baseUrl: "https://api.typesafe.ai",
		model: "jev-latest",
		apiKeyEnv: "TYPESAFE_API_KEY",
		allowExternalState: true,
		timeoutMs: 2500,
	});
});

test("reflex shadow sends minimized redacted state and logs probabilities without raw text", async () => {
	const store = await tempStore();
	const paths = new StorePaths(store);
	await writeText(paths.configFile, reflexConfig());
	let requestBody = "";
	const fetcher: typeof fetch = async (_input, init) => {
		requestBody = String(init?.body ?? "");
		return new Response(responseBody(), { status: 200, headers: { "content-type": "application/json" } });
	};

	const secret = "sk-123456789012345678901234567890";
	const result = await observeReflexShadow(
		paths,
		{
			source: "mirror",
			sessionId: "session-private",
			currentDecision: "surfaced",
			query: "Current turn " + secret,
			candidate: {
				noteId: "semantic/important-private-note",
				kind: "semantic",
				text: "Candidate memory " + secret,
			},
		},
		{
			env: { TYPESAFE_API_KEY: "test-key" },
			fetcher,
			now: () => "2026-09-21T00:00:00.000Z",
		},
	);

	assert.equal(result.status, "evaluated");
	assert.equal(result.signals?.recall_needed, 0.88);
	assert.equal(result.signals?.interrupt_user, 0.08);

	const request = JSON.parse(requestBody) as {
		state?: { query?: string; candidate?: { text?: string }; sessionId?: string; noteId?: string };
		questions?: Record<string, unknown>;
	};
	assert.equal(request.state?.sessionId, undefined);
	assert.equal(request.state?.noteId, undefined);
	assert.doesNotMatch(request.state?.query ?? "", /sk-123456/);
	assert.doesNotMatch(request.state?.candidate?.text ?? "", /sk-123456/);
	assert.equal(Object.keys(request.questions ?? {}).length, 8);

	const log = (await readText(join(store, ".her", "reflex-log.jsonl"))) ?? "";
	assert.match(log, /"status":"evaluated"/);
	assert.match(log, /"recall_needed":0\.88/);
	assert.doesNotMatch(log, /Current turn/);
	assert.doesNotMatch(log, /Candidate memory/);
	assert.doesNotMatch(log, /sk-123456/);
});

test("reflex shadow never exports protected Samantha zones", async () => {
	const store = await tempStore();
	const paths = new StorePaths(store);
	await writeText(paths.configFile, reflexConfig());
	let calls = 0;
	const fetcher: typeof fetch = async () => {
		calls += 1;
		return new Response(responseBody(), { status: 200 });
	};

	const result = await observeReflexShadow(
		paths,
		{
			source: "mirror",
			sessionId: "s1",
			currentDecision: "surfaced",
			candidate: { noteId: "samantha/journal/private", kind: "samantha", text: "never export me" },
		},
		{ env: { TYPESAFE_API_KEY: "test-key" }, fetcher },
	);

	assert.equal(result.status, "protected-zone");
	assert.equal(result.noteId, undefined);
	assert.equal(calls, 0);
	const log = (await readText(join(store, ".her", "reflex-log.jsonl"))) ?? "";
	assert.doesNotMatch(log, /never export me/);
	assert.doesNotMatch(log, /samantha\/journal/);
});

test("reflex v0 refuses active gating and external state remains opt-in", async () => {
	const store = await tempStore();
	const paths = new StorePaths(store);
	const base = parseReflexConfig(reflexConfig());

	const active = await observeReflexShadow(
		paths,
		{ source: "mirror", sessionId: "s1", currentDecision: "surfaced" },
		{ config: { ...base, shadow: false }, env: { TYPESAFE_API_KEY: "test-key" } },
	);
	assert.equal(active.status, "active-mode-blocked");

	const gated = await observeReflexShadow(
		paths,
		{ source: "mirror", sessionId: "s2", currentDecision: "surfaced" },
		{ config: { ...base, allowExternalState: false }, env: { TYPESAFE_API_KEY: "test-key" } },
	);
	assert.equal(gated.status, "privacy-gated");
});
