import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { startInquiry, tryMethod } from "../src/growth-experiment/loop.ts";
import type { ProbeInputContract } from "../src/growth-experiment/probe-contract.ts";
import type { Method, ProbeRequest } from "../src/growth-experiment/types.ts";
import { startDrain } from "../src/her-core/drain.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { FakeModel } from "../src/her-core/model.ts";

// These are offline engineering fixtures, not Samantha output or a reopened Pilot.
// Reviewed against the immutable observer's four input branches; combined text
// length and all other semantic restrictions remain enforced inside that script.
const contract: ProbeInputContract = {
	version: 1,
	discriminator: "kind",
	batch: { key: "cases", maxItems: 4 },
	variants: {
		"git-status": {
			checkoutAutocrlf: { type: "boolean" },
			readerConfig: { type: "string", values: ["inherit", "sanitized"] },
			newline: { type: "string", values: ["LF", "CRLF"] },
			content: { type: "string", optional: true, maxLength: 12000 },
		},
		"text-view": {
			content: { type: "string", maxLength: 12000 },
			leftView: { type: "string", values: ["raw", "normalize-lf"] },
			rightView: { type: "string", values: ["raw", "normalize-lf"] },
		},
		"text-pair": {
			left: { type: "string", maxLength: 12000 },
			right: { type: "string", maxLength: 12000 },
			rule: { type: "string", values: ["literal", "normalize-lf", "case-insensitive"] },
		},
		"binary-pair": {
			leftHex: { type: "string", maxLength: 12000, format: "hex-bytes" },
			rightHex: { type: "string", maxLength: 12000, format: "hex-bytes" },
		},
	},
};
const binary = { kind: "binary-pair", leftHex: "010203", rightHex: "010204" };
async function fixture(t: test.TestContext, batchKey = "cases") {
	const root = await mkdtemp(join(tmpdir(), "her-probe-contract-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = await readFile(
		new URL(
			"../../../docs/handoffs/2026-10-02-her-self-evolution/pilot-01-evidence/live/observe.mjs",
			import.meta.url,
		),
		"utf8",
	);
	await mkdir(join(root, "evals"));
	await writeFile(join(root, "evals/observe.mjs"), source);
	const task = {
		id: "final",
		description: "private final",
		environment: "binary",
		input: { ...binary, leftHex: "ab", rightHex: "cd" },
		expected: { equal: false },
	};
	const plan: GrowthHostPlan = {
		version: 1,
		inquiryId: "engineering-only",
		approvedBy: "offline test fixture",
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
			"observe-environment": {
				file: "evals/observe.mjs",
				sha256: sha256(source),
				purposes: ["probe", "applicability", "use", "review"],
				probeInputContract: { ...structuredClone(contract), batch: { key: batchKey, maxItems: 4 } },
			},
		},
		applicabilityOperation: "observe-environment",
		useOperation: "observe-environment",
		reviewOperation: "observe-environment",
		tasks: [task],
		review: {
			minGain: 0.5,
			cases: [
				{ ...task, id: "holdout", input: { ...binary, leftHex: "de" }, split: "holdout" },
				{ ...task, id: "regression", input: { ...binary, leftHex: "ef" }, split: "regression" },
			],
		},
	};
	const model = new FakeModel(
		'{"decision":"use","reason":"engineering selection fixture","adaptation":["engineering fixture"]}',
		false,
		{
			model: "deepseek-v4-flash",
			provider: "api.deepseek.com",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		},
	);
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	const host = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	await host.save(
		startInquiry(
			plan.inquiryId,
			[
				{
					id: "experience",
					taskId: "old",
					expectation: "fixture",
					observation: "fixture",
					evidence: [
						{
							ref: "fixture",
							digest: sha256("fixture"),
							origin: "environment",
							summary: "offline engineering input",
						},
					],
				},
			],
			{ thoughts: 10, probes: 2 },
		),
		-1,
	);
	return { root, plan, host, model };
}
function request(input: unknown, runId = "probe-run"): ProbeRequest {
	return {
		runId,
		inquiryId: "engineering-only",
		probe: {
			purpose: "offline engineering validation",
			action: JSON.stringify({ operationId: "observe-environment", input }),
			predictions: [{ hypothesisId: "fixture", outcome: "not a learning claim" }],
		},
	};
}
async function pending(host: HerGrowthHost, r: ProbeRequest) {
	const state = (await host.journal.state())!;
	await host.save(
		{
			...state,
			revision: state.revision + 1,
			phase: "pending-probe",
			pending: { kind: "probe", runId: r.runId, probe: r.probe },
		},
		state.revision,
	);
}

test("contract freezes with the real plan and reaches the actual reasoner prompt", async (t) => {
	const { root, host, plan, model } = await fixture(t);
	await host.reason({ stage: "investigate", instruction: "engineering prompt", data: {} });
	assert.match(model.calls[0].prompt, /allowedOperationIds/);
	assert.match(model.calls[0].prompt, /observe-environment/);
	assert.doesNotMatch(model.calls[0].prompt, /private final|evals\/observe.mjs/);
	assert.ok(Object.isFrozen(host.plan.operations["observe-environment"].probeInputContract!.variants));
	plan.operations["observe-environment"].probeInputContract!.batch!.maxItems = 3;
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	await assert.rejects(HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model), /frozen|changed/);
});

test("historical reply is unchanged, rejected before grant, and journal diagnostics bind the exact action", async (t) => {
	const { host, model } = await fixture(t);
	const history = JSON.parse(
		await readFile(new URL("./fixtures/growth-probe-pilot01-action.json", import.meta.url), "utf8"),
	);
	assert.equal(sha256(history.action), history.actionSha256);
	const r = request({});
	r.probe.action = history.action;
	assert.equal(await host.authorizeProbe(r), false);
	const rows = await host.journal.read();
	const rejected = rows.find((row) => row.kind === "probe-validation-rejected")!;
	assert.equal(rejected.data.actionDigest, history.actionSha256);
	assert.equal(rejected.data.planDigest, host.planDigest);
	assert.equal(rejected.data.runId, r.runId);
	assert.deepEqual(rejected.data.issues, [
		{ code: "unknown-operation", path: "action.operationId", expected: "observe-environment" },
	]);
	assert.equal(
		rows.some((row) => ["grant", "consume", "execution-intent"].includes(row.kind)),
		false,
	);
	assert.equal(model.calls.length, 0);
});

test("real journal append failure cannot grant invalid actions", async (t) => {
	const { host } = await fixture(t);
	// Inject only append failure; reads, plan, permissions and grant stay real.
	const append = t.mock.method(host.journal, "append", async () => {
		throw new Error("injected journal write failure");
	});
	await assert.rejects(host.authorizeProbe(request({ kind: "unrecognized" })), /journal write failure/);
	assert.equal(append.mock.callCount(), 1);
	assert.equal(append.mock.calls[0].arguments[0], "probe-validation-rejected");
	assert.equal(
		(await host.journal.read()).some((row) => row.kind === "grant"),
		false,
	);
});

test("runProbe revalidates structure before consuming a durable grant", async (t) => {
	const { host } = await fixture(t);
	const r = request(binary);
	assert.equal(await host.authorizeProbe(r), true);
	await pending(host, r);
	r.probe.action = JSON.stringify({ operationId: "observe-environment", input: { ...binary, leftHex: "zz" } });
	await assert.rejects(host.runProbe(r), /frozen input contract/);
	assert.equal(
		(await host.journal.read()).some((row) => ["consume", "execution-intent"].includes(row.kind)),
		false,
	);
});

for (const batchKey of ["cases", "samples"]) {
	test(`sealed tasks remain unavailable inside contract batch key ${batchKey}`, async (t) => {
		const { host, plan } = await fixture(t, batchKey);
		for (const task of [...plan.tasks, ...plan.review.cases]) {
			assert.equal(await host.authorizeProbe(request({ [batchKey]: [binary, task.input] }, task.id)), false);
		}
		assert.equal(
			(await host.journal.read()).some((row) => row.kind === "grant"),
			false,
		);
	});
}

test("STOP prevents contract-valid probes before grant", async (t) => {
	const { root, host } = await fixture(t);
	await startDrain({ memoryDir: root, reason: "offline test STOP" });
	await assert.rejects(host.authorizeProbe(request(binary)), /STOP/);
	assert.equal(
		(await host.journal.read()).some((row) => row.kind === "grant"),
		false,
	);
});

test("real host executes immutable observer: Windows Git, text view, text pair and binary; grant cannot replay", async (t) => {
	assert.equal(process.platform, "win32", "Windows Git verification is required, not silently skipped");
	const { host, model } = await fixture(t);
	const r = request({
		cases: [
			{ kind: "git-status", checkoutAutocrlf: false, readerConfig: "sanitized", newline: "LF" },
			{ kind: "text-view", content: "probe\r\n", leftView: "raw", rightView: "normalize-lf" },
			{ kind: "text-pair", left: "probe\r\n", right: "probe\n", rule: "normalize-lf" },
			binary,
		],
	});
	assert.equal(await host.authorizeProbe(r), true);
	await pending(host, r);
	const result = await host.runProbe(r);
	const observations = JSON.parse(result.summary).observations;
	assert.match(observations[0].facts.gitVersion, /^git version /);
	assert.deepEqual(
		observations.map((o: { value: unknown }) => o.value),
		[{ dirty: false }, { equal: false }, { equal: true }, { equal: false }],
	);
	for (const e of result.evidence)
		assert.equal(sha256(await readFile(join(host.journal.root, e.ref), "utf8")), e.digest);
	assert.equal(
		(await host.journal.read()).filter((row) => row.kind === "execution-result" && row.data.exitCode === 0).length,
		1,
	);
	await assert.rejects(host.runProbe(r), /consumed/);
	assert.equal(model.calls.length, 0);
});

test("shape-valid inputs still face the observer's real combined-length semantic guard", async (t) => {
	const { host } = await fixture(t);
	const r = request({ kind: "text-pair", left: "a".repeat(7000), right: "b".repeat(7000), rule: "literal" });
	assert.equal(await host.authorizeProbe(r), true);
	await pending(host, r);
	await assert.rejects(host.runProbe(r), /approved operation failed/);
	const execution = (await host.journal.read()).find((row) => row.kind === "execution-result")!;
	assert.notEqual(execution.data.exitCode, 0);
	await assert.rejects(host.runProbe(r), /consumed/);
});

test("original applicability observer returns unknown; real loop blocks without use or a correct-boundary claim", async (t) => {
	const { host, plan, model } = await fixture(t);
	const method: Method = {
		id: "engineering-method",
		status: "trial-ready",
		draft: {
			name: "fixture",
			problem: "fixture",
			preconditions: ["exact byte equality"],
			steps: ["fixture"],
			stopWhen: ["uncertain"],
			counterexamples: ["fixture"],
			sourceEvidenceRefs: ["fixture"],
		},
	};
	const initial = (await host.journal.state())!;
	const state = { ...initial, revision: 1, phase: "trial-ready" as const, method };
	await host.save(state, 0);
	const next = await tryMethod(state, plan.tasks[0], host);
	assert.equal(next.phase, "blocked");
	assert.match(next.note, /independent environment check missing/);
	assert.equal(next.trials.length, 0);
	const rows = await host.journal.read();
	assert.equal(
		rows.some((row) => ["grant", "consume", "use-result"].includes(row.kind)),
		false,
	);
	const execution = rows.find((row) => row.kind === "execution-result")!;
	const refs = execution.data.evidence as { ref: string }[];
	const log = JSON.parse(
		await readFile(join(host.journal.root, refs.find((e) => e.ref.endsWith(".log"))!.ref), "utf8"),
	);
	assert.equal(log.status, "unknown");
	assert.equal(Object.hasOwn(log, "met"), false);
	assert.equal(model.calls.length, 1, "only the explicit fake selection, no provider or solve call");
});
