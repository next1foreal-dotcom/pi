import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { runHerCli } from "../src/cli.ts";
import { growthExitCode } from "../src/growth-experiment/cli.ts";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { GrowthJournal, recallGrowthMethods } from "../src/growth-experiment/journal.ts";
import { startInquiry } from "../src/growth-experiment/loop.ts";
import { startDrain } from "../src/her-core/drain.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { CompletionResponseError, FakeModel } from "../src/her-core/model.ts";

const sample = {
	id: "observed-failure",
	taskId: "old-task",
	expectation: "all rows preserved",
	observation: "a row was lost",
	evidence: [{ ref: "old-result", digest: sha256("lost row"), origin: "environment" as const, summary: "lost row" }],
};
async function fixture(
	t: test.TestContext,
	model = new FakeModel('{"decision":"defer","reason":"no gap"}', false, {
		model: "deepseek-v4-flash",
		provider: "api.deepseek.com",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	}),
	configure?: (plan: GrowthHostPlan, root: string) => void | Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "her-growth-host-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const op =
		'import {readFileSync} from "node:fs"; const r=JSON.parse(readFileSync(0,"utf8")); console.log(JSON.stringify({value:r.answer??r,met:!!r.task?.environment?.includes("text"),credential:process.env.HER_LLM_API_KEY??null}));';
	await mkdir(join(root, "evals"));
	await writeFile(join(root, "evals/op.mjs"), op);
	const task = {
		id: "new-task",
		description: "preserve rows",
		environment: "text",
		input: { rows: ["a", "b"] },
		expected: { rows: ["a", "b"] },
	};
	const plan: GrowthHostPlan = {
		version: 1,
		inquiryId: "inquiry",
		approvedBy: "test owner: engineering fixture",
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		model: {
			request: "deepseek-v4-flash",
			reported: ["deepseek-v4-flash"],
			provider: "api.deepseek.com",
			maxOutputTokens: 128,
			inputUsdPerMillion: 0.3,
			outputUsdPerMillion: 1.2,
		},
		budget: { tokens: 30000, usd: 2, wallMs: 60000, processMs: 5000, outputBytes: 65536 },
		operations: {
			observe: { file: "evals/op.mjs", sha256: sha256(op), purposes: ["probe", "applicability", "use", "review"] },
		},
		applicabilityOperation: "observe",
		useOperation: "observe",
		reviewOperation: "observe",
		tasks: [task],
		review: {
			minGain: 0.5,
			cases: [
				{ ...task, id: "holdout", input: { rows: ["c"] }, split: "holdout" },
				{ ...task, id: "regression", input: { rows: ["d"] }, split: "regression" },
			],
		},
	};
	await configure?.(plan, root);
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	const host = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	await host.save(startInquiry("inquiry", [sample], { thoughts: 10, probes: 2 }), -1);
	return { root, host, plan, model };
}

test("real Markdown journal: revision zero, append-only CAS, restart and corruption refusal", async (t) => {
	const { root, host } = await fixture(t);
	const state = (await host.journal.state())!;
	const original = await readFile(host.journal.path, "utf8");
	const results = await Promise.allSettled([
		host.save({ ...state, revision: 1 }, 0),
		host.save({ ...state, revision: 1 }, 0),
	]);
	assert.equal(results.filter((v) => v.status === "fulfilled").length, 1);
	assert.ok((await readFile(host.journal.path, "utf8")).startsWith(original));
	assert.equal((await new GrowthJournal(root, "inquiry").state())?.revision, 1);
	await writeFile(host.journal.path, `${await readFile(host.journal.path, "utf8")}partial write`);
	await assert.rejects(host.journal.state(), /incomplete/);
});

test("model host records actual usage and monthly cost ledger; preset reply is only engineering evidence", async (t) => {
	const { host, root } = await fixture(t);
	const answer = await host.reason({ stage: "discover", instruction: "Return JSON", data: { observed: "lost row" } });
	assert.equal((answer as { decision: string }).decision, "defer");
	const rows = await host.journal.read();
	const result = rows.find((r) => r.kind === "model-result")!;
	assert.equal(result.data.tokens, 30);
	assert.ok(Number(result.data.usd) > 0);
	const audit = await readFile(join(root, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8");
	assert.match(audit, /growth-model/);
});

test("budget/STOP reject before provider call and frozen plans cannot be replaced", async (t) => {
	const { host, root, model, plan } = await fixture(t);
	await startDrain({ memoryDir: root, reason: "STOP during growth" });
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /STOP/);
	assert.equal(model.calls.length, 0);
	await writeFile(
		join(root, "evals/plan.json"),
		JSON.stringify({ ...plan, budget: { ...plan.budget, tokens: 9999 } }),
	);
	await assert.rejects(
		HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model),
		/changed after freeze/,
	);
});

test("unknown usage leaves durable reservation, blocks replay across new host instance", async (t) => {
	const { host, root } = await fixture(t, new FakeModel("{}"));
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /usage/);
	const model = new FakeModel("{}");
	const next = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	await assert.rejects(next.reason({ stage: "discover", instruction: "JSON", data: {} }), /unreconciled/);
	assert.equal(model.calls.length, 0);
});

test("real task executor runs only granted frozen actions, preserves logs and drops credentials", async (t) => {
	const { host } = await fixture(t);
	const state = (await host.journal.state())!;
	const request = {
		inquiryId: "inquiry",
		runId: "real-run",
		probe: {
			purpose: "observe data",
			action: JSON.stringify({ operationId: "observe", input: { rows: [1, 2] } }),
			predictions: [
				{ hypothesisId: "a", outcome: "two rows" },
				{ hypothesisId: "b", outcome: "one row" },
			],
		},
	};
	assert.equal(
		await host.authorizeProbe({ ...request, probe: { ...request.probe, action: "powershell destroy" } }),
		false,
	);
	assert.equal(await host.authorizeProbe(request), true);
	await assert.rejects(host.runProbe(request), /durable pending/);
	await host.save(
		{
			...state,
			revision: 1,
			phase: "pending-probe",
			pending: { kind: "probe", runId: request.runId, probe: request.probe },
		},
		0,
	);
	const result = await host.runProbe(request);
	assert.equal(result.outcome, "success");
	assert.match(result.summary, /"credential":null/);
	assert.equal(result.evidence.length, 2);
	for (const receipt of result.evidence)
		assert.equal(sha256(await readFile(join(host.journal.root, receipt.ref))), receipt.digest);
	await assert.rejects(host.runProbe(request), /consumed/);
	const execution = (await host.journal.read()).find((r) => r.kind === "execution-result")!;
	const experience = await host.taskExperience(String(execution.data.bgTaskId), "two rows expected");
	assert.match(experience.observation, /rows/);
	assert.deepEqual(await recallGrowthMethods(host.journal.root), []);
});

// These responses test real host plumbing only. They supply the lesson and cannot establish learning.
test("independent paired review uses actual executor artifacts, sealed cases and measured costs; no final replay", async (t) => {
	const { host, plan, model } = await fixture(t);
	const initial = (await host.journal.state())!;
	const draft = {
		name: "bounded row method",
		problem: "rows",
		preconditions: ["text"],
		steps: ["preserve records"],
		stopWhen: ["unsupported format"],
		counterexamples: ["image"],
		sourceEvidenceRefs: ["old-result"],
	};
	const method = { id: sha256(JSON.stringify(draft)), draft, status: "candidate" as const };
	const seen: string[] = [];
	model.completeWithMeta = (prompt, options) => {
		model.calls.push({ prompt, strong: false, maxTokens: options?.maxTokens });
		seen.push(prompt);
		const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)) as {
			task: { id: string };
			availableMethod?: unknown;
		};
		const value = data.task.id === "regression" || data.availableMethod ? { rows: ["a", "b"] } : { rows: [] };
		return {
			text: JSON.stringify(value),
			model: "deepseek-v4-flash",
			provider: "api.deepseek.com",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		};
	};
	await host.save({ ...initial, revision: 1, phase: "pending-review", method }, 0);
	const receipt = await host.review(method, ["old-task"]);
	assert.equal(receipt.decision, "eligible-for-review");
	assert.equal(receipt.planDigest, host.planDigest);
	assert.equal(seen.length, 4);
	assert.ok(seen.every((p) => !p.includes('"expected"')));
	const records = await host.journal.read();
	const review = records.find((r) => r.kind === "review-result")!;
	const pairs = review.data.pairs as Array<{ baseline: { cost: number }; candidate: { cost: number } }>;
	assert.ok(pairs.every((p) => p.baseline.cost > 0 && p.candidate.cost > 0));
	await assert.rejects(host.review(method, ["old-task"]), /already consumed/);
	const state = (await host.journal.state())!;
	await host.save(
		{ ...state, revision: 2, phase: "trial-ready", method: { ...method, status: "trial-ready", review: receipt } },
		1,
	);
	assert.equal((await recallGrowthMethods(host.journal.root)).length, 1);
	const task = plan.tasks[0];
	const use = {
		runId: "new-use",
		task: { id: task.id, description: task.description, environment: task.environment },
		method: { ...method, status: "trial-ready" as const, review: receipt },
		adaptation: ["current input"],
	};
	assert.equal(
		await host.authorizeUse({ ...use, method: { ...use.method, draft: { ...draft, steps: ["tampered"] } } }),
		false,
	);
	assert.equal(await host.authorizeUse(use), true);
	await host.save(
		{
			...state,
			revision: 3,
			phase: "pending-use",
			method: use.method,
			pending: {
				kind: "use",
				runId: use.runId,
				task: use.task,
				methodId: method.id,
				selection: { decision: "use", reason: "fit", adaptation: use.adaptation },
			},
		},
		2,
	);
	const used = await host.runUse(use);
	assert.equal(used.outcome, "success");
	assert.equal(used.taskId, task.id);
	assert.equal(used.methodId, method.id);
	const env = await host.checkApplicability(use.method, { ...use.task, environment: "image" });
	assert.equal(env.met, false);
	const saved = (await host.journal.state())!;
	await host.save(
		{ ...saved, revision: 4, phase: "suspended", pending: undefined, method: { ...use.method, status: "suspended" } },
		3,
	);
	assert.equal((await recallGrowthMethods(host.journal.root)).length, 0);
});

test("task execution interruption stays pending, consumed action cannot run again", async (t) => {
	const { host } = await fixture(t);
	const state = (await host.journal.state())!;
	const req = {
		runId: "abort-run",
		inquiryId: state.id,
		probe: {
			purpose: "probe",
			action: JSON.stringify({ operationId: "observe", input: { a: 1 } }),
			predictions: [
				{ hypothesisId: "a", outcome: "yes" },
				{ hypothesisId: "b", outcome: "no" },
			],
		},
	};
	await host.authorizeProbe(req);
	await host.save(
		{ ...state, revision: 1, phase: "pending-probe", pending: { kind: "probe", runId: req.runId, probe: req.probe } },
		0,
	);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(host.runProbe(req, controller.signal), /abort/i);
	await assert.rejects(host.runProbe(req), /consumed/);
	assert.equal((await host.journal.state())?.phase, "pending-probe");
});

test("budget exhaustion survives reopening and blocks before a model call", async (t) => {
	const { host, model } = await fixture(t);
	await host.journal.append("model-result", { runId: "prior", tokens: 30000, usd: 0.1 });
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /budget/);
	assert.equal(model.calls.length, 0);
	await assert.rejects(
		host
			.authorizeProbe({
				inquiryId: "inquiry",
				runId: "../escape",
				probe: { purpose: "x", action: JSON.stringify({ operationId: "observe", input: {} }), predictions: [] },
			})
			.then((allowed) => {
				if (!allowed) throw new Error("denied");
			}),
		/denied/,
	);
});

test("failed response retains fresh real usage, never settles with stale metadata", async (t) => {
	const { host, model, root } = await fixture(t);
	const meta = {
		model: "deepseek-v4-flash",
		provider: "api.deepseek.com",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	};
	model.completeWithMeta = () => {
		model.lastCompletion = meta;
		throw new Error("model returned empty content");
	};
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /empty content/);
	const result = (await host.journal.read()).find((r) => r.kind === "model-result")!;
	assert.equal(result.data.tokens, 30);
	assert.equal(result.data.error, "model returned empty content");
	assert.match(
		await readFile(join(root, "audit", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8"),
		/growth-model/,
	);
	model.lastCompletion = meta;
	model.completeWithMeta = () => {
		throw new Error("HTTP failure before usage");
	};
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /real usage/);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "model-result").length, 1);
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /unreconciled/);
});

test("formal CLI reads persisted state and wakes from a real completed task without resetting budget", async (t) => {
	const { host, root } = await fixture(t);
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let output = "";
	stdout.on("data", (chunk) => {
		output += chunk.toString();
	});
	assert.equal(
		await runHerCli(["growth", "status", root, "evals/plan.json"], {}, process.cwd(), { stdout, stderr }),
		0,
	);
	assert.equal(JSON.parse(output).state.revision, 0);
	const state = (await host.journal.state())!;
	const request = {
		inquiryId: state.id,
		runId: "wake-result",
		probe: {
			purpose: "observe",
			action: JSON.stringify({ operationId: "observe", input: { actual: "task result" } }),
			predictions: [],
		},
	};
	await host.authorizeProbe(request);
	await host.save(
		{
			...state,
			revision: 1,
			phase: "pending-probe",
			pending: { kind: "probe", runId: request.runId, probe: request.probe },
		},
		0,
	);
	await host.runProbe(request);
	await host.save({ ...state, revision: 2, phase: "deferred", spent: { ...state.spent, thoughts: 2 } }, 1);
	const execution = (await host.journal.read()).find((r) => r.kind === "execution-result")!;
	output = "";
	assert.equal(
		await runHerCli(
			["growth", "wake", root, "evals/plan.json", String(execution.data.bgTaskId), "actual task result"],
			{},
			process.cwd(),
			{ stdout, stderr },
		),
		0,
	);
	const reopened = JSON.parse(output);
	assert.equal(reopened.phase, "discover");
	assert.equal(reopened.experiences.length, 2);
	assert.equal(reopened.spent.thoughts, 2);
	assert.equal(growthExitCode({ phase: "blocked" }), 1);
	assert.equal(growthExitCode({ phase: "pending-probe" }), 1);
	assert.equal(growthExitCode({ phase: "deferred" }), 0);
});

// Real journal/lock/audit and CLI dependencies below. Model replies remain engineering fixtures.
function enableProbePolicy(plan: GrowthHostPlan): void {
	plan.model.requestOptions = { requireComplete: true };
}
function echoProbe(model: FakeModel): void {
	model.completeWithMeta = (prompt, options) => {
		model.calls.push({ prompt, strong: false, maxTokens: options?.maxTokens });
		return {
			text: prompt.slice(prompt.indexOf("{")),
			finishReason: "stop",
			model: "deepseek-v4-flash",
			provider: "api.deepseek.com",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		};
	};
}
test("probe-model records a bound receipt without touching inquiry or heldout", async (t) => {
	const { host, model } = await fixture(t, undefined, enableProbePolicy);
	echoProbe(model);
	const before = await host.journal.state();
	const result = await host.probeModel();
	assert.equal(result.status, "model-ready");
	assert.equal(result.scope, "provider-response-only");
	assert.equal(result.planDigest, host.planDigest);
	assert.equal(result.tokens, 30);
	assert.ok(result.estimatedUsd > 0);
	assert.equal(model.calls.length, 1);
	assert.deepEqual(await host.journal.state(), before);
	const rows = await host.journal.read();
	assert.equal(rows.filter((r) => r.kind === "model-probe-result").length, 1);
	assert.equal(rows.find((r) => r.kind === "model-result")?.data.runId, result.runId);
	assert.ok(!rows.some((r) => r.kind.startsWith("review-") || r.kind.startsWith("execution-")));
	assert.ok(!model.calls[0].prompt.includes("holdout"));
});
test("probe-model rejects plans lacking frozen strict policy before any request", async (t) => {
	const { host, model } = await fixture(t);
	await assert.rejects(host.probeModel(), /frozen requireComplete/);
	assert.equal(model.calls.length, 0);
});
for (const block of ["unknown", "expired", "stop", "cancel", "tokens", "usd"] as const) {
	test(`probe-model ${block} prevents a provider request with real host gates`, async (t) => {
		const { host, model, root } = await fixture(t, undefined, (plan) => {
			enableProbePolicy(plan);
			if (block === "expired") plan.expiresAt = new Date(0).toISOString();
			if (block === "tokens") plan.budget.tokens = 1;
			if (block === "usd") plan.budget.usd = 0.000001;
		});
		if (block === "unknown")
			await host.journal.append("model-reserve", {
				runId: "old-unknown",
				reservedTokens: 6877,
				reservedUsd: 0.0082524,
			});
		if (block === "stop") await startDrain({ memoryDir: root, reason: "probe STOP" });
		const controller = new AbortController();
		if (block === "cancel") controller.abort();
		const before = await readFile(host.journal.path, "utf8");
		await assert.rejects(host.probeModel(controller.signal));
		assert.equal(model.calls.length, 0);
		assert.equal(await readFile(host.journal.path, "utf8"), before);
	});
}
test("probe-model invalid JSON is charged and failed, without a repair request", async (t) => {
	const model = new FakeModel("not-json", false, {
		finishReason: "stop",
		model: "deepseek-v4-flash",
		provider: "api.deepseek.com",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	});
	const { host } = await fixture(t, model, enableProbePolicy);
	const result = await host.probeModel();
	assert.equal(result.status, "probe-failed");
	assert.equal(growthExitCode(result), 1);
	assert.equal(result.tokens, 30);
	assert.equal(model.calls.length, 1);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "model-result").length, 1);
});
test("probe-model receipt persistence failure never returns model-ready", async (t) => {
	const { host, model } = await fixture(t, undefined, enableProbePolicy);
	echoProbe(model);
	const append = host.journal.append.bind(host.journal);
	host.journal.append = async (kind, data) => {
		if (kind === "model-probe-result") throw new Error("receipt storage unavailable");
		return append(kind, data);
	};
	await assert.rejects(host.probeModel(), /receipt storage/);
	assert.equal(model.calls.length, 1);
	assert.equal((await host.journal.read()).filter((r) => r.kind === "model-result").length, 1);
});
test("standalone and formal CLI probe-model bootstrap real dependencies over loopback only", async (t) => {
	let requests = 0;
	let invalidEcho = false;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests++;
		const prompt = body.messages[0].content as string;
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				id: "loopback-request",
				model: "deepseek-v4-flash",
				choices: [
					{ finish_reason: "stop", message: { content: invalidEcho ? "{}" : prompt.slice(prompt.indexOf("{")) } },
				],
				usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const provider = `127.0.0.1:${address.port}`;
	const { root, host } = await fixture(t, undefined, async (plan, root) => {
		enableProbePolicy(plan);
		plan.model.provider = provider;
		await mkdir(join(root, ".her"));
		await writeFile(
			join(root, ".her/config.yaml"),
			`llm:\n  base_url: http://${provider}\n  model_fast: deepseek-v4-flash\n  model_strong: deepseek-v4-pro\n  api_key_env: TEST_PROBE_KEY\n`,
		);
	});
	const state = await host.journal.state();
	const command = promisify(execFile);
	const options = {
		cwd: process.cwd(),
		env: { ...process.env, TEST_PROBE_KEY: "loopback-fixture-only" },
		timeout: 20000,
	};
	const success = await command(
		process.execPath,
		["--import", "tsx", "packages/her/src/growth-experiment/cli.ts", "probe-model", root, "evals/plan.json"],
		options,
	);
	assert.equal(JSON.parse(success.stdout).status, "model-ready");
	assert.equal(requests, 1);
	invalidEcho = true;
	await assert.rejects(
		command(
			process.execPath,
			["--import", "tsx", "packages/her/src/cli.ts", "growth", "probe-model", root, "evals/plan.json"],
			options,
		),
		(error: unknown) => {
			const result = error as Error & { code: number; stdout: string };
			assert.equal(result.code, 1);
			assert.equal(JSON.parse(result.stdout).status, "probe-failed");
			return true;
		},
	);
	assert.equal(requests, 2);
	invalidEcho = false;
	const auth = await oneShotAuthorization(host);
	await writeFile(join(root, "evals/probe-authorization.json"), JSON.stringify(auth));
	const oneShotArgs = [
		"--import",
		"tsx",
		"packages/her/src/cli.ts",
		"growth",
		"probe-model",
		root,
		"evals/plan.json",
		"evals/probe-authorization.json",
	];
	const third = await command(process.execPath, oneShotArgs, options);
	assert.equal(JSON.parse(third.stdout).status, "model-ready");
	await assert.rejects(command(process.execPath, oneShotArgs, options));
	assert.equal(requests, 3);
	assert.deepEqual(await host.journal.state(), state);
});

async function oneShotAuthorization(host: HerGrowthHost) {
	const reservation = await host.journal.append("model-reserve", {
		runId: "accepted-old",
		reservedTokens: 6877,
		reservedUsd: 0.0082524,
	});
	const decision = await host.journal.append("human-spend-risk-acceptance", {
		runId: "accepted-old",
		reservationDigest: reservation.digest,
		approvedBy: "owner fixture",
		actualTokens: "unknown",
		actualUsd: "unknown",
	});
	return {
		version: 1 as const,
		scope: "provider-response-only" as const,
		inquiryId: host.plan.inquiryId,
		planDigest: host.planDigest,
		approvedBy: "owner fixture",
		historicalRunId: "accepted-old",
		reservationDigest: reservation.digest,
		decisionDigest: decision.digest,
		startsAt: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		maxRequests: 1 as const,
		requireComplete: true as const,
		budget: { tokens: 10000, usd: 0.1 },
	};
}
test("owner one-shot probe preserves expired plan/unknown history and cannot replay or resume learning", async (t) => {
	const { host, model, root } = await fixture(t, undefined, (plan) => {
		plan.expiresAt = new Date(0).toISOString();
	});
	echoProbe(model);
	const authorization = await oneShotAuthorization(host);
	const original = await readFile(host.journal.path, "utf8");
	const planBytes = await readFile(join(root, "evals/plan.json"));
	const state = await host.journal.state();
	const result = await host.probeModel(undefined, authorization);
	assert.equal(result.status, "model-ready");
	assert.equal(model.calls.length, 1);
	assert.ok((await readFile(host.journal.path, "utf8")).startsWith(original));
	assert.deepEqual(await readFile(join(root, "evals/plan.json")), planBytes);
	assert.deepEqual(await host.journal.state(), state);
	assert.ok(
		!(await host.journal.read()).some((row) => row.kind === "model-result" && row.data.runId === "accepted-old"),
	);
	await assert.rejects(host.probeModel(undefined, authorization), /consumed/);
	await assert.rejects(
		host.probeModel(undefined, { ...authorization, expiresAt: new Date(Date.now() + 90000).toISOString() }),
		/changed|consumed/,
	);
	const reopened = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	await assert.rejects(reopened.probeModel(undefined, authorization), /consumed/);
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /wall-clock/);
	assert.equal(model.calls.length, 1);
});
for (const blocked of [
	"other-unknown",
	"expired",
	"future",
	"decision",
	"reservation",
	"plan",
	"tokens",
	"usd",
	"stop",
	"cancel",
	"window",
] as const) {
	test(`owner one-shot probe ${blocked} remains fail-closed`, async (t) => {
		const { host, model, root } = await fixture(t);
		echoProbe(model);
		const auth = await oneShotAuthorization(host);
		if (blocked === "other-unknown") await host.journal.append("model-reserve", { runId: "other" });
		if (blocked === "expired") {
			auth.startsAt = new Date(Date.now() - 2000).toISOString();
			auth.expiresAt = new Date(Date.now() - 1000).toISOString();
		}
		if (blocked === "future") auth.startsAt = new Date(Date.now() + 10000).toISOString();
		if (blocked === "decision") auth.decisionDigest = "wrong";
		if (blocked === "reservation") auth.reservationDigest = "wrong";
		if (blocked === "plan") auth.planDigest = "wrong";
		if (blocked === "tokens") auth.budget.tokens = 1;
		if (blocked === "usd") auth.budget.usd = 0.000001;
		if (blocked === "window") auth.expiresAt = new Date(Date.now() + 700000).toISOString();
		if (blocked === "stop") await startDrain({ memoryDir: root, reason: "owner probe STOP" });
		const controller = new AbortController();
		if (blocked === "cancel") controller.abort();
		await assert.rejects(host.probeModel(controller.signal, auth));
		assert.equal(model.calls.length, 0);
	});
}
test("owner one-shot probe new unknown usage consumes permission without granting another exception", async (t) => {
	const { host, model } = await fixture(t, new FakeModel("{}", false, { finishReason: "stop" }));
	const auth = await oneShotAuthorization(host);
	await assert.rejects(host.probeModel(undefined, auth), /real usage/);
	await assert.rejects(host.probeModel(undefined, auth), /consumed|unreconciled/);
	assert.equal(model.calls.length, 1);
	assert.equal((await host.journal.read()).filter((row) => row.kind === "model-unknown").length, 1);
});

test("host uses immutable failure usage instead of another request's lastCompletion", async (t) => {
	const { host, model } = await fixture(t);
	model.completeWithMeta = () => {
		const failure = new CompletionResponseError("empty_content", {
			model: "deepseek-v4-flash",
			provider: "api.deepseek.com",
			finishReason: "stop",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		});
		model.lastCompletion = { model: "another-request", usage: { total_tokens: 999 } };
		throw failure;
	};
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /empty content/);
	const receipt = (await host.journal.read()).find((row) => row.kind === "model-result")!;
	assert.equal(receipt.data.tokens, 30);
	assert.equal(receipt.data.model, "deepseek-v4-flash");
});
test("host retains observed usage on unapproved identity without settling it", async (t) => {
	const { host } = await fixture(
		t,
		new FakeModel("{}", false, {
			finishReason: "stop",
			model: "unapproved-version",
			provider: "api.deepseek.com",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		}),
	);
	await assert.rejects(host.reason({ stage: "discover", instruction: "JSON", data: {} }), /real usage/);
	const rows = await host.journal.read();
	const unknown = rows.find((row) => row.kind === "model-unknown")!;
	assert.deepEqual(unknown.data.observedUsage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
	assert.equal(unknown.data.reportedModel, "unapproved-version");
	assert.equal(unknown.data.finishReason, "stop");
	assert.ok(!rows.some((row) => row.kind === "model-result"));
});
