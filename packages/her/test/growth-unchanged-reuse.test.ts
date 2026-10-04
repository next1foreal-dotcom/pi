import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { advance, startInquiry, tryMethod } from "../src/growth-experiment/loop.ts";
import { createReasoner } from "../src/growth-experiment/model.ts";
import type {
	Evidence,
	GrowthHost,
	GrowthState,
	Selection,
	UseRequest,
} from "../src/growth-experiment/types.ts";

// Real driver and model adapter, scripted completion and host ports.
// These fixtures establish control-flow behavior, not live learning, OS isolation, or paid-host acceptance.
const evidence = (ref: string): Evidence => ({
	ref,
	digest: createHash("sha256").update(ref).digest("hex"),
	origin: "environment",
	summary: ref,
});
const task = { id: "fresh-task", description: "Process a matching text record.", environment: "synthetic-workspace" };
const unchanged: Selection = { decision: "use", reason: "The method fits without changes.", adaptation: [] };

function harness(selection: Selection = unchanged) {
	const calls: string[] = [];
	const prompts: string[] = [];
	const saves: GrowthState[] = [];
	const uses: UseRequest[] = [];
	let current: GrowthState = {
		...startInquiry(
			"unchanged-reuse",
			[
				{
					id: "experience",
					taskId: "training-task",
					expectation: "A complete record.",
					observation: "A record was omitted.",
					evidence: [evidence("training-receipt")],
				},
			],
			{ thoughts: 8, probes: 1 },
		),
		phase: "trial-ready",
		method: {
			id: "synthetic-reviewed-method",
			status: "trial-ready",
			draft: {
				name: "Respect the text contract",
				problem: "Preserve complete records.",
				preconditions: ["A matching text contract."],
				steps: ["Read the contract, process the record, and check its count."],
				stopWhen: ["The contract is unknown."],
				counterexamples: ["Binary input."],
				sourceEvidenceRefs: ["training-receipt"],
			},
		},
	};
	const reason = createReasoner(
		{
			complete: (prompt) => {
				prompts.push(prompt);
				return JSON.stringify(selection);
			},
		},
		512,
	);
	let granted: UseRequest | undefined;
	const host: GrowthHost = {
		reason: async (request, signal) => {
			calls.push("reason");
			return reason(request, signal);
		},
		save: async (next, expectedRevision) => {
			assert.equal(expectedRevision, current.revision, "stale revision");
			current = structuredClone(next);
			saves.push(current);
		},
		authorizeProbe: async () => {
			throw new Error("unexpected probe authorization");
		},
		runProbe: async () => {
			throw new Error("unexpected probe execution");
		},
		review: async () => {
			throw new Error("unexpected review of seeded fixture");
		},
		checkApplicability: async (method, requestedTask) => {
			calls.push("applicability");
			assert.equal(method.id, current.method?.id);
			assert.deepEqual(requestedTask, task);
			return { met: true, evidence: [evidence("applicability-receipt")] };
		},
		authorizeUse: async (request) => {
			calls.push("authorize");
			granted = structuredClone(request);
			return true;
		},
		runUse: async (request) => {
			calls.push("use");
			assert.deepEqual(request, granted, "execution must use the authorized request");
			assert.equal(current.phase, "pending-use", "reserve before execution");
			assert.equal(current.pending?.runId, request.runId);
			assert.ok(Object.isFrozen(request.adaptation));
			uses.push(structuredClone(request));
			return {
				runId: request.runId,
				methodId: request.method.id,
				taskId: request.task.id,
				outcome: "success",
				summary: "Synthetic task result.",
				evidence: [evidence("use-receipt")],
			};
		},
	};
	return { host, calls, prompts, saves, uses, initial: structuredClone(current) };
}

test("unchanged reuse reaches execution only after applicability, authorization, and reservation", async () => {
	const h = harness();
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "trial-ready");
	assert.equal(result.trials[0]?.observation?.outcome, "success");
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize", "use"]);
	assert.deepEqual(h.uses[0]?.adaptation, []);
	assert.deepEqual(result.trials[0]?.selection.adaptation, []);
	assert.equal(result.spent.thoughts, 1);
	assert.match(h.prompts[0], /unchanged reuse/);
	assert.match(h.prompts[0], /do not invent a change/);
});

test("real adaptations still reach the same authorized execution path", async () => {
	const h = harness({ ...unchanged, adaptation: ["  Use the current input path.  "] });
	await tryMethod(h.initial, task, h.host);
	assert.deepEqual(h.uses[0]?.adaptation, ["Use the current input path."]);
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize", "use"]);
});

test("declining unchanged reuse does not call applicability or execution", async () => {
	const h = harness({ ...unchanged, decision: "deliberate" });
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.trials[0]?.status, "declined");
	assert.deepEqual(h.calls, ["reason"]);
});

test("unmet applicability still prevents authorization and use", async () => {
	const h = harness();
	const check = h.host.checkApplicability;
	h.host.checkApplicability = async (...args) => ({ ...(await check(...args)), met: false });
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.trials[0]?.status, "out-of-scope");
	assert.deepEqual(h.calls, ["reason", "applicability"]);
});

test("missing applicability evidence blocks unchanged reuse", async () => {
	const h = harness();
	const check = h.host.checkApplicability;
	h.host.checkApplicability = async (...args) => ({ ...(await check(...args)), evidence: [] });
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "blocked");
	assert.match(result.note, /evidence/);
	assert.deepEqual(h.calls, ["reason", "applicability"]);
});

test("an applicability port error cannot become implicit approval", async () => {
	const h = harness();
	h.host.checkApplicability = async () => {
		h.calls.push("applicability");
		throw new Error("applicability unavailable");
	};
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "blocked");
	assert.match(result.note, /unavailable/);
	assert.deepEqual(h.calls, ["reason", "applicability"]);
});

test("unchanged reuse still requires permission for the current task", async () => {
	const h = harness();
	h.host.authorizeUse = async () => {
		h.calls.push("authorize");
		return false;
	};
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.trials[0]?.status, "denied");
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize"]);
	assert.equal(h.uses.length, 0);
});

test("a host authorization error is preserved without execution or automatic retry", async () => {
	const h = harness();
	h.host.authorizeUse = async () => {
		h.calls.push("authorize");
		throw new Error("host stopped this run");
	};
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "blocked");
	assert.match(result.note, /stopped/);
	await tryMethod(result, task, h.host);
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize"]);
});

test("exhausted thought budget prevents even the selection call", async () => {
	const h = harness();
	h.initial.limits.thoughts = 0;
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "deferred");
	assert.match(result.note, /budget/);
	assert.deepEqual(h.calls, []);
});

test("a host reasoning error does not bypass its budget or stop decision", async () => {
	const h = harness();
	h.host.reason = async () => {
		h.calls.push("reason");
		throw new Error("host budget unavailable");
	};
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "blocked");
	assert.match(result.note, /budget/);
	assert.deepEqual(h.calls, ["reason"]);
});

test("cancellation before unchanged reuse prevents all host calls", async () => {
	const h = harness();
	const control = new AbortController();
	control.abort();
	await assert.rejects(tryMethod(h.initial, task, h.host, control.signal), /abort/i);
	assert.deepEqual(h.calls, []);
});

test("cancellation while persisting pending use prevents execution", async () => {
	const h = harness();
	const control = new AbortController();
	const save = h.host.save;
	h.host.save = async (...args) => {
		await save(...args);
		if (args[0].phase === "pending-use") control.abort();
	};
	const result = await tryMethod(h.initial, task, h.host, control.signal);
	assert.equal(result.phase, "pending-use");
	assert.match(result.note, /abort/i);
	assert.equal(h.uses.length, 0);
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize"]);
});

test("an interrupted unchanged use stays pending and is not replayed", async () => {
	const h = harness();
	h.host.runUse = async () => {
		h.calls.push("use");
		throw new Error("result channel lost");
	};
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "pending-use");
	assert.match(result.note, /reconciliation/);
	await tryMethod(result, task, h.host);
	await advance(result, h.host);
	assert.deepEqual(h.calls, ["reason", "applicability", "authorize", "use"]);
});

for (const key of ["methodId", "taskId", "runId"] as const) {
	test(`unchanged use rejects a mismatched ${key} receipt`, async () => {
		const h = harness();
		const run = h.host.runUse;
		h.host.runUse = async (...args) => ({ ...(await run(...args)), [key]: "another-run-or-object" });
		const result = await tryMethod(h.initial, task, h.host);
		assert.equal(result.phase, "pending-use");
		assert.equal(result.trials.length, 0);
		assert.match(result.note, /mismatch/);
	});
}

test("an unchanged use without result evidence cannot count as success", async () => {
	const h = harness();
	const run = h.host.runUse;
	h.host.runUse = async (...args) => ({ ...(await run(...args)), evidence: [] });
	const result = await tryMethod(h.initial, task, h.host);
	assert.equal(result.phase, "pending-use");
	assert.equal(result.trials.length, 0);
	assert.match(result.note, /evidence/);
});

for (const outcome of ["failure", "unknown"] as const) {
	test(`unchanged use with ${outcome} outcome suspends the method`, async () => {
		const h = harness();
		const run = h.host.runUse;
		h.host.runUse = async (...args) => ({ ...(await run(...args)), outcome });
		const result = await tryMethod(h.initial, task, h.host);
		assert.equal(result.phase, "suspended");
		assert.equal(result.method?.status, "suspended");
		await tryMethod(result, task, h.host);
		assert.equal(h.uses.length, 1);
	});
}

test("concurrent unchanged uses cannot both reserve the same state revision", async () => {
	const h = harness();
	const results = await Promise.allSettled([
		tryMethod(h.initial, task, h.host),
		tryMethod(h.initial, task, h.host),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(h.uses.length, 1);
});
