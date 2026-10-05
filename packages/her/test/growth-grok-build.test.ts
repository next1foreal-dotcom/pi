import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	GROK_BUILD_ENDPOINT,
	GROK_BUILD_PROVIDER,
	GrokBuildModel,
	grokBuildSpend,
	type NativeExecutor,
	parseGrokBuildReceipt,
} from "../src/growth-experiment/grok-build.ts";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { GrowthJournal } from "../src/growth-experiment/journal.ts";
import { startInquiry } from "../src/growth-experiment/loop.ts";
import { assertNativeFirstPurpose, auditNativeDiscovery } from "../src/growth-experiment/native-readiness.ts";
import { runGrowthPilot } from "../src/growth-experiment/pilot.ts";
import {
	auditGrowthPilot,
	growthPilotProposalDigest,
	validatePilotAuthorization,
} from "../src/growth-experiment/pilot-authorization.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { authorizePilotFixture } from "./fixtures/growth-pilot-owner.ts";
import { fixture, original } from "./fixtures/growth-task-host.ts";

// Preset native JSON and injected executors verify engineering only. No supplier, OAuth or learning calls.
function reply(sessionId = "fixture-session") {
	return {
		text: '{"decision":"defer","reason":"synthetic transport fixture"}',
		sessionId,
		requestId: "fixture-request",
		stopReason: "end_turn",
		num_turns: 1,
		usage: {
			input_tokens: 20,
			cache_read_input_tokens: 8,
			cache_creation_input_tokens: 2,
			output_tokens: 10,
			total_tokens: 40,
			reasoning_tokens: 3,
		},
		modelUsage: { "grok-4.5": { inputTokens: 20, cacheReadInputTokens: 8, outputTokens: 10, modelCalls: 1 } },
	};
}
test("native disjoint cache buckets, reasoning subset and absent invoice retain actual totals", () => {
	const result = parseGrokBuildReceipt(reply(), "fixture-session", ["grok-4.5"]);
	assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 });
	assert.equal(result.model, "grok-4.5");
	assert.equal(result.finishReason, "stop");
	assert.equal(result.diagnostics?.httpStatus, 0);
	assert.equal(grokBuildSpend(result).providerReportedUsd, "unknown");
	assert.equal(grokBuildSpend(result).nativeReceipt?.reasoning, 3);
	const cost = { ...reply(), total_cost_usd: 0.0001 };
	assert.equal(
		grokBuildSpend(parseGrokBuildReceipt(cost, "fixture-session", ["grok-4.5"])).providerReportedUsd,
		0.0001,
	);
	assert.equal(
		grokBuildSpend(parseGrokBuildReceipt({ ...cost, cost_is_partial: true }, "fixture-session", ["grok-4.5"]))
			.providerReportedUsd,
		"unknown",
	);
});
for (const fault of [
	"missing-usage",
	"missing-total",
	"wrong-total",
	"reasoning-over-output",
	"incomplete",
	"two-calls",
	"two-models",
	"wrong-model",
	"wrong-session",
	"negative",
	"missing-stop",
] as const) {
	test(`native ${fault} cannot become a complete channel receipt`, () => {
		const data: Record<string, unknown> = reply();
		const usage = data.usage as Record<string, unknown>;
		const model = (data.modelUsage as Record<string, Record<string, unknown>>)["grok-4.5"];
		if (fault === "missing-usage") delete data.usage;
		if (fault === "missing-total") delete usage.total_tokens;
		if (fault === "wrong-total") usage.total_tokens = 43;
		if (fault === "reasoning-over-output") usage.reasoning_tokens = 11;
		if (fault === "incomplete") data.usage_is_incomplete = true;
		if (fault === "two-calls") model.modelCalls = 2;
		if (fault === "two-models") data.modelUsage = { "grok-4.5": model, "side-model": model };
		if (fault === "wrong-model") data.modelUsage = { "grok-4.6": model };
		if (fault === "wrong-session") {
			assert.throws(() => parseGrokBuildReceipt(data, "another-session", ["grok-4.5"]), /another session/);
			return;
		}
		if (fault === "negative") usage.input_tokens = -1;
		if (fault === "missing-stop") delete data.stopReason;
		const result = parseGrokBuildReceipt(data, "fixture-session", ["grok-4.5"]);
		if (fault === "missing-stop") assert.equal(result.finishReason, undefined);
		else assert.notEqual(result.diagnostics?.usageStatus, "complete");
	});
}
async function approveFixture(root: string, plan: GrowthHostPlan, extra: Record<string, unknown> = {}) {
	const auth = plan.pilotAuthorization!;
	auth.proposalDigest = growthPilotProposalDigest(plan);
	const path = join(root, auth.approval.file);
	const approval = JSON.parse(await readFile(path, "utf8"));
	Object.assign(approval, {
		endpoint: auth.endpoint,
		proposalDigest: auth.proposalDigest,
		modelProbe: auth.modelProbe,
		acceptsNativeLimits: true,
		nativePolicy: plan.model.grokBuild,
		...(auth.additionalHistoricalUnknown
			? { acceptsAdditionalHistoricalUnknown: true, additionalHistoricalUnknown: auth.additionalHistoricalUnknown }
			: {}),
		...extra,
	});
	const bytes = JSON.stringify(approval);
	await writeFile(path, bytes);
	auth.approval.sha256 = sha256(bytes);
	await writeFile(join(root, "evals/native-plan.json"), JSON.stringify(plan));
}
async function nativeFixture(
	t: TestContext,
	response: (sessionId: string) => Record<string, unknown> = reply,
	exitCode = 0,
) {
	const { root, host: oldHost } = await fixture(t);
	const plan: GrowthHostPlan = structuredClone(oldHost.plan);
	plan.inquiryId = "native-inquiry";
	const task = (id: string) => ({
		id,
		description: id,
		environment: "text",
		input: { marker: id },
		expected: { ok: true },
	});
	plan.tasks = [task("T1"), task("T2"), task("T3"), task("T4"), task("development")];
	plan.pilot = { finalTaskIds: ["T1", "T2", "T3", "T4"], developmentTaskId: "development", thoughts: 12, probes: 2 };
	await authorizePilotFixture(root, plan, [original]);
	const executable = join(root, "fixture-executable");
	await writeFile(executable, "never execute this test sentinel");
	Object.assign(plan.model, {
		request: "grok-4.5",
		reported: ["grok-4.5"],
		provider: GROK_BUILD_PROVIDER,
		inputUsdPerMillion: 2,
		outputUsdPerMillion: 6,
		grokBuild: {
			kind: "grok-build",
			executable: { path: executable, sha256: sha256("never execute this test sentinel") },
			authPath: join(root, "nonexistent-test-auth"),
			reasoningEffort: "low",
			usdAccounting: "api-equivalent-estimate",
			reasoningAccounting: "return-time",
		},
	});
	plan.pilotAuthorization!.endpoint = GROK_BUILD_ENDPOINT;
	plan.pilotAuthorization!.modelProbe = { scope: "first-discovery-response" };
	await approveFixture(root, plan);
	const calls: Parameters<NativeExecutor>[0][] = [];
	const executor: NativeExecutor = async (request) => {
		calls.push(request);
		const sessionId = request.args[request.args.indexOf("--session-id") + 1];
		return { stdout: JSON.stringify(response(sessionId)), exitCode };
	};
	const model = new GrokBuildModel(
		root,
		plan,
		{ XAI_API_KEY: "synthetic-must-not-propagate", GROK_MAX_RETRIES: "99" },
		executor,
	);
	const host = await HerGrowthHost.open(root, "evals/native-plan.json", join(root, "candidate"), model);
	await host.save(startInquiry(plan.inquiryId, [original], { thoughts: 12, probes: 2 }), -1);
	return { root, host, plan, model, calls };
}
test("native real host path uses exactly one injected executor; preserves original history and eight missing outcomes", async (t) => {
	const { host, calls, root } = await nativeFixture(t);
	const old = new GrowthJournal(root, "historical-inquiry");
	const before = await readFile(old.path);
	const report = await runGrowthPilot(host);
	assert.equal(report.status, "NO-METHOD");
	assert.equal(report.rows.length, 8);
	assert.ok(report.rows.every((row) => row.status === "missing"));
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.equal(call.env.XAI_API_KEY, undefined);
	assert.equal(call.env.GROK_MAX_RETRIES, "0");
	assert.equal(call.env.GROK_MEMORY, "0");
	assert.ok(call.args.includes("--disable-web-search"));
	assert.equal(call.args[call.args.indexOf("--tools") + 1], "");
	const config = JSON.parse(await readFile(call.env.GROK_CONFIG_PATH!, "utf8"));
	assert.equal(config.models.max_retries, 0);
	assert.equal(config.models.max_completion_tokens, 128);
	assert.equal(config.features.title_refresh, false);
	assert.equal(config.doom_loop_recovery.enabled, false);
	assert.equal(config.auth.disable_api_key_auth, true);
	const rows = await host.journal.read();
	assert.ok(!rows.some((r) => r.kind === "model-probe-result"));
	const result = rows.find((r) => r.kind === "model-result")!;
	assert.deepEqual(result.data.nativeReadiness, { scope: "first-discovery-response", status: "model-ready" });
	assert.equal(result.data.providerReportedUsd, "unknown");
	assert.equal(result.data.costBasis, "api-equivalent-estimate");
	assert.equal(result.data.tokens, 40);
	assert.deepEqual(await readFile(old.path), before);
	await assert.rejects(runGrowthPilot(host));
	assert.equal(calls.length, 1);
});
for (const fault of ["unknown", "failed", "malformed", "reasoning-overrun"] as const) {
	test(`native ${fault} stops real runner without retry or invented readiness`, async (t) => {
		const { host, calls } = await nativeFixture(
			t,
			(sessionId) => {
				const result: Record<string, unknown> = reply(sessionId);
				if (fault === "unknown") delete result.usage;
				if (fault === "malformed") result.text = "not JSON";
				if (fault === "reasoning-overrun") {
					result.usage = {
						input_tokens: 20,
						cache_read_input_tokens: 8,
						cache_creation_input_tokens: 2,
						output_tokens: 90000,
						total_tokens: 90030,
						reasoning_tokens: 89990,
					};
					result.modelUsage = {
						"grok-4.5": { inputTokens: 20, cacheReadInputTokens: 8, outputTokens: 90000, modelCalls: 1 },
					};
				}
				return result;
			},
			fault === "failed" ? 1 : 0,
		);
		const report = await runGrowthPilot(host);
		assert.equal(report.status, "INCOMPLETE");
		assert.equal(calls.length, 1);
		await assert.rejects(host.assertRunning());
		assert.equal(calls.length, 1);
		const rows = await host.journal.read();
		if (fault !== "reasoning-overrun") assert.ok(!rows.some((r) => r.data.nativeReadiness));
		if (fault === "unknown") assert.equal(rows.filter((r) => r.kind === "model-result").length, 0);
		if (fault === "reasoning-overrun") assert.equal(rows.find((r) => r.kind === "model-result")!.data.tokens, 90030);
	});
}
test("native owner/policy/port binding cannot reuse old readiness or substitute a fake model", async (t) => {
	const { root, plan, model, calls } = await nativeFixture(t);
	await assert.rejects(
		HerGrowthHost.open(root, "evals/native-plan.json", join(root, "candidate"), { complete: () => "{}" }),
		/native model port/,
	);
	await approveFixture(root, plan, { acceptsNativeLimits: false });
	await assert.rejects(validatePilotAuthorization(root, plan), /owner acceptance/);
	await approveFixture(root, plan);
	plan.model.maxOutputTokens++;
	await assert.rejects(model.verifyBinding(plan, root), /not bound/);
	assert.equal(calls.length, 0);
});
test("native discovery is first paid purpose and pending receipts never grant readiness", async (t) => {
	const { host, plan, calls } = await nativeFixture(t);
	assert.throws(() => assertNativeFirstPurpose(plan, [], "reflect"), /first real discovery/);
	await host.journal.append("model-reserve", { runId: "missing-result", purpose: "discover" });
	assert.doesNotThrow(() => auditNativeDiscovery(plan, []));
	const rows = await host.journal.read();
	assert.throws(() => auditNativeDiscovery(plan, rows), /lacks actual/);
	await assert.rejects(host.assertRunning());
	assert.equal(calls.length, 0);
});

for (const fault of [
	"accepted-specific",
	"not-accepted",
	"missing-decision",
	"fake-settlement",
	"foreign-unknown",
	"new-unknown",
] as const) {
	test(`additional stopped historical unknown ${fault} preserves all other unknown guards`, async (t) => {
		const { root, plan, host, calls } = await nativeFixture(t);
		const historical = new GrowthJournal(root, "new-stopped-history");
		const planDigest = sha256("additional original fixture plan");
		await historical.append("plan", { digest: planDigest });
		const reserve = await historical.append("model-reserve", { runId: "new-old-unknown", reservedTokens: 500 });
		await historical.append("model-unknown", {
			runId: "new-old-unknown",
			actualTokens: "unknown",
			actualUsd: "unknown",
		});
		const stop = await historical.append("pilot-stop", { status: "INCOMPLETE", reason: "synthetic prior stop" });
		const decision = await historical.append("human-spend-risk-acceptance", {
			runId: "new-old-unknown",
			reservationDigest: reserve.digest,
			actualTokens: "unknown",
			actualUsd: "unknown",
		});
		const before = await readFile(historical.path);
		const auth = plan.pilotAuthorization!;
		auth.previousPilot = { inquiryId: historical.id, stopDigest: stop.digest };
		auth.additionalHistoricalUnknown = {
			inquiryId: historical.id,
			planDigest,
			runId: "new-old-unknown",
			reservationDigest: reserve.digest,
			decisionDigest: decision.digest,
		};
		const approvedAt = new Date().toISOString();
		auth.startsAt = new Date(Date.now() + 1000).toISOString();
		plan.expiresAt = auth.expiresAt = new Date(Date.parse(auth.startsAt) + plan.budget.wallMs).toISOString();
		await approveFixture(root, plan, {
			previousPilot: auth.previousPilot,
			approvedAt,
			...(fault === "not-accepted" ? { acceptsAdditionalHistoricalUnknown: false } : {}),
		});
		if (fault === "missing-decision") {
			auth.additionalHistoricalUnknown.decisionDigest = sha256("missing");
			await approveFixture(root, plan, { previousPilot: auth.previousPilot, approvedAt });
		}
		if (fault === "fake-settlement")
			await historical.append("model-result", { runId: "new-old-unknown", tokens: 0, usd: 0 });
		if (fault === "foreign-unknown")
			await new GrowthJournal(root, "unapproved-other").append("model-reserve", { runId: "another-unknown" });
		if (fault === "new-unknown")
			await host.journal.append("model-reserve", { runId: "current-unknown", purpose: "discover" });
		if (fault === "accepted-specific") {
			const snapshot = await auditGrowthPilot(root, plan);
			assert.equal(snapshot.additionalHistoricalUnknown?.tokens, "unknown");
			assert.equal(snapshot.totalTokens, "unknown");
			assert.equal(snapshot.totalUsd, "unknown");
			assert.deepEqual(await readFile(historical.path), before);
		} else await assert.rejects(auditGrowthPilot(root, plan));
		assert.equal(calls.length, 0);
	});
}

test("native error before session creation retains explicit diagnosis and unknown usage without retry", async (t) => {
	const { host, calls } = await nativeFixture(
		t,
		() => ({ type: "error", message: "synthetic OAuth quota exhausted" }),
		1,
	);
	const report = await runGrowthPilot(host);
	assert.equal(report.status, "INCOMPLETE");
	assert.equal(report.usage.tokens, null);
	assert.match(report.reason, /usage\/model identity required/);
	const unknown = (await host.journal.read()).find((r) => r.kind === "model-unknown")!;
	assert.match(String(unknown.data.error), /exit=1; synthetic OAuth quota exhausted/);
	assert.equal(calls.length, 1);
});
test("another native inquiry's unknown invoice cannot borrow the current owner cost exception", async (t) => {
	const { root, plan, calls } = await nativeFixture(t);
	const foreign = new GrowthJournal(root, "foreign-native");
	await foreign.append("model-reserve", { runId: "foreign-native-result" });
	await foreign.append("model-result", {
		runId: "foreign-native-result",
		tokens: 30,
		usd: 0.001,
		costBasis: "api-equivalent-estimate",
		providerReportedUsd: "unknown",
	});
	plan.pilotAuthorization!.startsAt = new Date(Date.now() + 1000).toISOString();
	plan.expiresAt = plan.pilotAuthorization!.expiresAt = new Date(
		Date.parse(plan.pilotAuthorization!.startsAt) + plan.budget.wallMs,
	).toISOString();
	await approveFixture(root, plan);
	await assert.rejects(auditGrowthPilot(root, plan), /subscription cost outside/);
	assert.equal(calls.length, 0);
});
