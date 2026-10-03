import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	evaluateApplicability,
	renderApplicabilityFacts,
	validateApplicabilityFacts,
} from "../src/growth-experiment/applicability.ts";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { startInquiry, tryMethod } from "../src/growth-experiment/loop.ts";
import type { Method } from "../src/growth-experiment/types.ts";
import { startDrain } from "../src/her-core/drain.ts";
import { canonicalJson, sha256 } from "../src/her-core/improvement-plan.ts";
import { FakeModel } from "../src/her-core/model.ts";

// Hand-authored offline fixtures verify infrastructure; no learned method claim.
const facts = {
	"runtime.platform": { type: "string" },
	"input.kind": { type: "string" },
	"comparison.rule": { type: "string" },
	"data.encoding": { type: "string" },
	"data.hasCRLF": { type: "boolean" },
	"data.totalBytes": { type: "number" },
	"git.readerAutocrlf": { type: "boolean" },
	"git.version": { type: "string" },
} as const;
const textInput = { kind: "text-pair", left: "line\r\n", right: "line\n", rule: "normalize-lf" };
const method: Method = {
	id: "fixture-method",
	status: "trial-ready",
	draft: {
		name: "engineering fixture",
		problem: "fixture",
		preconditions: [
			JSON.stringify({ fact: "data.encoding", oneOf: ["utf8"] }),
			JSON.stringify({ fact: "comparison.rule", oneOf: ["normalize-lf"] }),
		],
		steps: ["fixture"],
		stopWhen: ["unknown"],
		counterexamples: ["fixture"],
		sourceEvidenceRefs: ["fixture"],
	},
};
async function fixture(
	t: test.TestContext,
	input = textInput as Record<string, unknown>,
	configure?: (plan: GrowthHostPlan, root: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "her-applicability-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "evals"));
	const source = await readFile(
		new URL("../src/growth-experiment/observe-applicability.mjs", import.meta.url),
		"utf8",
	);
	await writeFile(join(root, "evals/facts.mjs"), source);
	const useSource = await readFile(
		new URL(
			"../../../docs/handoffs/2026-10-02-her-self-evolution/pilot-01-evidence/live/observe.mjs",
			import.meta.url,
		),
		"utf8",
	);
	await writeFile(join(root, "evals/use.mjs"), useSource);
	const task = {
		id: "task",
		description: "engineering only",
		environment: "isolated",
		input: input as GrowthHostPlan["tasks"][number]["input"],
		expected: { equal: true },
	};
	const plan: GrowthHostPlan = {
		version: 1,
		inquiryId: "engineering-applicability",
		approvedBy: "offline fixture",
		expiresAt: new Date(Date.now() + 120000).toISOString(),
		model: {
			request: "deepseek-v4-flash",
			reported: ["deepseek-v4-flash"],
			provider: "api.deepseek.com",
			maxOutputTokens: 128,
			inputUsdPerMillion: 0.3,
			outputUsdPerMillion: 1.2,
		},
		budget: { tokens: 30000, usd: 2, wallMs: 120000, processMs: 10000, outputBytes: 65536 },
		operations: {
			facts: { file: "evals/facts.mjs", sha256: sha256(source), purposes: ["applicability"] },
			use: { file: "evals/use.mjs", sha256: sha256(useSource), purposes: ["use", "review"] },
		},
		applicabilityOperation: "facts",
		applicabilityFacts: facts,
		useOperation: "use",
		reviewOperation: "use",
		tasks: [task],
		review: {
			minGain: 0.5,
			cases: [
				{ ...task, id: "holdout", input: { kind: "heldout" }, split: "holdout" },
				{ ...task, id: "regression", input: { kind: "regression" }, split: "regression" },
			],
		},
	};
	await configure?.(plan, root);
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	const model = new FakeModel('{"decision":"use","reason":"offline fixture","adaptation":["fixture"]}', false, {
		model: "deepseek-v4-flash",
		provider: "api.deepseek.com",
		usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
	});
	const host = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	const initial = startInquiry(
		plan.inquiryId,
		[
			{
				id: "fixture",
				taskId: "old",
				expectation: "fixture",
				observation: "fixture",
				evidence: [{ ref: "fixture", digest: sha256("fixture"), origin: "environment", summary: "fixture" }],
			},
		],
		{ thoughts: 10, probes: 2 },
	);
	await host.save({ ...initial, phase: "trial-ready", method }, -1);
	return {
		root,
		plan,
		task: { id: task.id, description: task.description, environment: task.environment },
		host,
		model,
	};
}
test("real file facts satisfy explicit conditions, with a bound receipt and no provider call", async (t) => {
	const { host, task, model } = await fixture(t);
	const result = await host.checkApplicability(method, task);
	assert.equal(result.met, true);
	const row = (await host.journal.read()).find((r) => r.kind === "applicability-result")!;
	assert.equal(row.data.status, "met");
	assert.equal(row.data.methodDigest, sha256(canonicalJson(method)));
	assert.equal(row.data.planDigest, host.planDigest);
	assert.equal(row.data.taskId, task.id);
	for (const e of result.evidence)
		assert.equal(sha256(await readFile(join(host.journal.root, e.ref), "utf8")), e.digest);
	assert.equal(model.calls.length, 0);
});
test("changed real rule or binary encoding rejects use; host rejection is out-of-scope, not model decline", async (t) => {
	for (const input of [
		{ ...textInput, rule: "literal" },
		{ kind: "binary-pair", leftHex: "0d0a", rightHex: "0a" },
	]) {
		const { host, task } = await fixture(t, input);
		assert.equal((await host.checkApplicability(method, task)).met, false);
		const state = (await host.journal.state())!;
		const next = await tryMethod(state, task, host);
		assert.equal(next.trials[0].status, "out-of-scope");
		assert.equal(next.trials[0].selection.decision, "use");
		assert.equal(
			(await host.journal.read()).some((r) => r.kind === "grant" || r.kind === "use-result"),
			false,
		);
	}
});
test("unverifiable natural language, missing facts and malformed constraints stay unknown", async (t) => {
	const { host, task } = await fixture(t);
	for (const preconditions of [
		["all semantic differences are irrelevant"],
		[JSON.stringify({ fact: "not-approved", oneOf: [true] })],
		[JSON.stringify({ fact: "git.version", oneOf: ["guessed"] })],
		[JSON.stringify({ fact: "data.hasCRLF", oneOf: ["true"] })],
		[],
	]) {
		await assert.rejects(
			host.checkApplicability({ ...method, draft: { ...method.draft, preconditions } }, task),
			/unknown/,
		);
	}
	assert.equal(
		(await host.journal.read()).some((r) => r.kind === "grant"),
		false,
	);
});
test("direct authorization cannot bypass checks or borrow another method/task receipt", async (t) => {
	const { host, task } = await fixture(t);
	const r = { runId: "use-fixture", task, method, adaptation: ["fixture"] };
	assert.equal(await host.authorizeUse(r), false);
	await host.checkApplicability(method, task);
	assert.equal(await host.authorizeUse({ ...r, task: { ...task, id: "other" } }), false);
	assert.equal(
		await host.authorizeUse({ ...r, method: { ...method, draft: { ...method.draft, preconditions: ["unknown"] } } }),
		false,
	);
	assert.equal(await host.authorizeUse(r), true);
});
test("only declared scalar facts can be cataloged; no answers, defaults or loose conditions", () => {
	for (const invalid of [
		{},
		{ constructor: { type: "string" } },
		{ safe: { type: "object" } },
		{ safe: { type: "boolean", answer: true } },
	])
		assert.throws(() => validateApplicabilityFacts(invalid as unknown as typeof facts));
	assert.match(renderApplicabilityFacts(facts), /JSON-encoded strings/);
	assert.doesNotMatch(renderApplicabilityFacts(facts), /fixture-method|line\\r|equal|expected/);
	for (const condition of [
		{ fact: "data.totalBytes", oneOf: [NaN] },
		{ fact: "data.encoding", oneOf: [] },
		{ fact: "data.encoding", oneOf: ["utf8"], optional: true },
		{ fact: "data.encoding", oneOf: ["utf8"], action: "trust me" },
	])
		assert.equal(
			evaluateApplicability(
				[JSON.stringify(condition)],
				{ status: "observed", facts: { "data.encoding": "utf8" } },
				facts,
			).status,
			"unknown",
		);
	assert.equal(
		evaluateApplicability(
			[
				JSON.stringify({ fact: "data.encoding", oneOf: ["bytes"] }),
				JSON.stringify({ fact: "git.version", oneOf: ["unknown"] }),
			],
			{ status: "observed", facts: { "data.encoding": "utf8" } },
			facts,
		).status,
		"unknown",
	);
	assert.equal(
		evaluateApplicability(
			method.draft.preconditions,
			{
				status: "observed",
				facts: { "data.encoding": "utf8", "comparison.rule": "normalize-lf", secretAnswer: true },
			},
			facts,
		).status,
		"unknown",
	);
});

test("Windows Git fact is measured under the selected isolated reader configuration", async (t) => {
	assert.equal(process.platform, "win32", "Windows measurement required, never silently skipped");
	for (const readerConfig of ["inherit", "sanitized"]) {
		const { host, task } = await fixture(t, {
			kind: "git-status",
			gitBinary: "C:\\Program Files\\Git\\cmd\\git.exe",
			checkoutAutocrlf: true,
			readerConfig,
			newline: "CRLF",
		});
		const scoped = {
			...method,
			draft: { ...method.draft, preconditions: [JSON.stringify({ fact: "git.readerAutocrlf", oneOf: [true] })] },
		};
		const result = await host.checkApplicability(scoped, task);
		assert.equal(result.met, readerConfig === "inherit");
		const output = JSON.parse(
			await readFile(join(host.journal.root, result.evidence.find((e) => e.ref.endsWith(".log"))!.ref), "utf8"),
		);
		assert.match(output.facts["git.version"], /^git version /);
		assert.equal(output.facts["data.hasCRLF"], true);
		assert.equal(Object.hasOwn(output.facts, "dirty"), false);
	}
});

test("new fact catalog stays frozen and reaches the reasoner without final-case answers", async (t) => {
	const { root, plan, host, model } = await fixture(t);
	await host.reason({ stage: "investigate", instruction: "offline", data: {} });
	assert.match(model.calls[0].prompt, /applicabilityFacts/);
	assert.doesNotMatch(model.calls[0].prompt, /leftHex|engineering-method|evals\/facts.mjs/);
	assert.ok(Object.isFrozen(host.plan.applicabilityFacts));
	const changed = structuredClone(plan);
	changed.applicabilityFacts!["data.encoding"].type = "boolean";
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(changed));
	await assert.rejects(
		HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model),
		/changed after freeze/,
	);
});

test("a later unknown receipt invalidates a positive grant before consume or paid solve", async (t) => {
	const { host, task, model } = await fixture(t);
	const r = { runId: "use-run", task, method, adaptation: ["fixture"] };
	await host.checkApplicability(method, task);
	assert.equal(await host.authorizeUse(r), true);
	const state = (await host.journal.state())!;
	await host.save(
		{
			...state,
			revision: 1,
			phase: "pending-use",
			pending: {
				kind: "use",
				runId: r.runId,
				task,
				methodId: method.id,
				selection: { decision: "use", reason: "fixture", adaptation: ["fixture"] },
			},
		},
		0,
	);
	await assert.rejects(
		host.checkApplicability({ ...method, draft: { ...method.draft, preconditions: ["unverifiable"] } }, task),
		/unknown/,
	);
	await assert.rejects(host.runUse(r), /verified applicability receipt required/);
	assert.equal(
		(await host.journal.read()).some((row) => row.kind === "consume" || row.kind === "model-reserve"),
		false,
	);
	assert.equal(model.calls.length, 0);
});

test("facts persistence failure prevents use even though the real collector completed", async (t) => {
	const { host, task } = await fixture(t);
	const append = host.journal.append.bind(host.journal);
	t.mock.method(host.journal, "append", async (kind: string, data: Record<string, unknown>) => {
		if (kind === "applicability-result") throw new Error("injected applicability receipt failure");
		return append(kind, data);
	});
	await assert.rejects(host.checkApplicability(method, task), /receipt failure/);
	assert.equal((await host.journal.read()).filter((row) => row.kind === "execution-result").length, 1);
	assert.equal(await host.authorizeUse({ runId: "use-run", task, method, adaptation: [] }), false);
});

test("a boolean-only evaluator cannot masquerade as observed facts", async (t) => {
	const { host, task } = await fixture(t, textInput, async (plan, root) => {
		const source = "console.log(JSON.stringify({met:true}));";
		await writeFile(join(root, "evals/facts.mjs"), source);
		plan.operations.facts.sha256 = sha256(source);
	});
	await assert.rejects(host.checkApplicability(method, task), /unknown/);
	assert.equal(await host.authorizeUse({ runId: "use-run", task, method, adaptation: [] }), false);
});

test("STOP and persistent pilot-stop block observation before a process or model starts", async (t) => {
	for (const mode of ["stop", "pilot-stop"]) {
		const { root, host, task, model } = await fixture(t);
		if (mode === "stop") await startDrain({ memoryDir: root, reason: "offline STOP" });
		else await host.journal.append("pilot-stop", { reason: "fixture" });
		await assert.rejects(host.checkApplicability(method, task), /STOP|pilot stopped/);
		assert.equal(
			(await host.journal.read()).some((row) => row.kind === "execution-intent" || row.kind === "grant"),
			false,
		);
		assert.equal(model.calls.length, 0);
	}
});
test("positive applicability reaches real method execution; a wrong fake answer remains a failure", async (t) => {
	const { host, task, model } = await fixture(t);
	const next = await tryMethod((await host.journal.state())!, task, host);
	assert.equal(next.trials[0].status, "observed");
	assert.equal(next.trials[0].observation?.outcome, "failure");
	assert.equal(next.phase, "suspended");
	assert.equal((await host.journal.read()).filter((row) => row.kind === "consume").length, 1);
	assert.equal(model.calls.length, 2, "explicit fake selection and solve, no provider");
});
