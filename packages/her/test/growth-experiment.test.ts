import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advance, reconcile, reconcileReview, reopen, startInquiry, tryMethod } from "../src/growth-experiment/loop.ts";
import { createReasoner } from "../src/growth-experiment/model.ts";
import type {
	Evidence,
	Experience,
	GrowthHost,
	GrowthState,
	MethodDraft,
	Observation,
	ReasonRequest,
} from "../src/growth-experiment/types.ts";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const evidence = (ref: string, summary = ref): Evidence => ({
	ref,
	digest: hash(summary),
	origin: "environment",
	summary,
});
const experience: Experience = {
	id: "experience-1",
	taskId: "training-1",
	expectation: "Two records should produce two valid output rows.",
	observation: "Only one output row appeared.",
	evidence: [evidence("receipt-1")],
};
const question = {
	problem: "What caused the missing row?",
	hypotheses: [
		{ id: "format", explanation: "The two inputs use different separators." },
		{ id: "units", explanation: "One value uses an unsupported unit." },
	],
	wakeWhen: "New input or output evidence is available.",
};
const probe = {
	purpose: "Distinguish separator handling from unit handling.",
	action: "Inspect a permitted minimal sample while holding the units constant.",
	predictions: [
		{ hypothesisId: "format", outcome: "Only the separator variation loses the row." },
		{ hypothesisId: "units", outcome: "Both separator variations preserve the row." },
	],
};
const draft: MethodDraft = {
	name: "Normalize only after detecting the input contract",
	problem: "Heterogeneous text data with an explicit output contract.",
	preconditions: ["Text input with a detectable separator."],
	steps: ["Read the input contract.", "Normalize supported records.", "Compare output count with input count."],
	stopWhen: ["The input encoding or format cannot be determined."],
	counterexamples: ["An image is not a delimited text table."],
	sourceEvidenceRefs: ["receipt-1", "probe-evidence"],
};
// Scripted model responses intentionally supply the lesson. These are engineering fixtures,
// not evidence of autonomous discovery, transfer, or real Samantha improvement.
const learningReplies = () => [
	{ decision: "investigate", question },
	{ decision: "probe", probe },
	{ decision: "method", method: draft },
];
function harness(replies: unknown[] = learningReplies()) {
	let revision = 0;
	const saves: GrowthState[] = [];
	const requests: ReasonRequest[] = [];
	const probes: string[] = [];
	const uses: string[] = [];
	let useOutcome: Observation["outcome"] = "success";
	const host: GrowthHost = {
		reason: async (request) => {
			requests.push(structuredClone(request));
			assert.ok(replies.length, "no scripted response remaining");
			return structuredClone(replies.shift());
		},
		save: async (state, expected) => {
			assert.equal(expected, revision, "stale revision");
			revision = state.revision;
			saves.push(structuredClone(state));
		},
		authorizeProbe: async () => true,
		runProbe: async (request) => {
			probes.push(request.runId);
			return {
				runId: request.runId,
				outcome: "success",
				summary: "Separator variation lost a row.",
				evidence: [evidence("probe-evidence")],
			};
		},
		review: async (method) => ({
			methodId: method.id,
			planDigest: hash("frozen-host-plan"),
			decision: "eligible-for-review",
			heldOutTaskIds: ["heldout-1"],
			evidence: [evidence("independent-review")],
		}),
		checkApplicability: async () => ({ met: true, evidence: [evidence("preconditions")] }),
		authorizeUse: async () => true,
		runUse: async (request) => {
			uses.push(request.runId);
			return {
				runId: request.runId,
				methodId: request.method.id,
				taskId: request.task.id,
				outcome: useOutcome,
				summary: `Host observed ${useOutcome}.`,
				evidence: [evidence(`trial-${uses.length}`)],
			};
		},
	};
	return {
		host,
		saves,
		requests,
		probes,
		uses,
		replies,
		setOutcome: (outcome: Observation["outcome"]) => {
			useOutcome = outcome;
		},
	};
}
const initial = () => startInquiry("inquiry-1", [experience], { thoughts: 20, probes: 3 });
async function learned(h: ReturnType<typeof harness>): Promise<GrowthState> {
	let state = initial();
	for (let i = 0; i < 4; i++) state = await advance(state, h.host);
	assert.equal(state.phase, "trial-ready");
	return state;
}
const useReply = { decision: "use", reason: "The documented input contract fits.", adaptation: ["Use current paths."] };
const task = { id: "new-task", description: "Reconcile a new tabular export.", environment: "isolated-text-workspace" };

test("four stages: discover, investigate, review, use in fresh state, suspend, reopen", async () => {
	const h = harness();
	let state = await learned(h);
	assert.equal(h.probes.length, 1);
	assert.equal(state.method?.status, "trial-ready");
	assert.ok(state.method?.id);
	// Serializing and reopening simulates a fresh context, not a real LLM session.
	state = JSON.parse(JSON.stringify(state)) as GrowthState;
	h.replies.push(useReply);
	state = await tryMethod(state, task, h.host);
	assert.equal(state.trials[0].observation?.outcome, "success");
	assert.equal(h.uses.length, 1);
	h.setOutcome("failure");
	h.replies.push(useReply);
	state = await tryMethod(state, { ...task, id: "changed-condition" }, h.host);
	assert.equal(state.phase, "suspended");
	assert.equal(state.method?.status, "suspended");
	const stopped = await tryMethod(state, { ...task, id: "must-not-run" }, h.host);
	assert.equal(stopped.phase, "suspended");
	assert.equal(h.uses.length, 2);
	state = await reopen(
		state,
		[
			{
				...experience,
				id: "experience-2",
				taskId: "changed-condition",
				evidence: [evidence("new-evidence")],
			},
		],
		h.host,
	);
	assert.equal(state.phase, "discover");
	assert.equal(state.retired.length, 1);
	assert.equal(state.retired[0].status, "suspended");
	assert.equal(state.method, undefined);
});

test("no-learning-needed is a real branch; no probe or method is manufactured", async () => {
	const h = harness([{ decision: "defer", reason: "One lookup would suffice." }]);
	const state = await advance(initial(), h.host);
	assert.equal(state.phase, "deferred");
	assert.equal(h.probes.length, 0);
	assert.equal(state.method, undefined);
});

test("a probe whose hypotheses predict the same outcome is refused before execution", async () => {
	const h = harness();
	await advance(initial(), h.host);
	h.replies[0] = {
		decision: "probe",
		probe: {
			...probe,
			predictions: probe.predictions.map((p) => ({ ...p, outcome: "same outcome" })),
		},
	};
	const state = await advance(h.saves.at(-1)!, h.host);
	assert.equal(state.phase, "blocked");
	assert.match(state.note, /distinguish/);
	assert.equal(h.probes.length, 0);
});

test("candidate cannot cite invented evidence", async () => {
	const h = harness();
	let state = await advance(initial(), h.host);
	state = await advance(state, h.host);
	h.replies[0] = { decision: "method", method: { ...draft, sourceEvidenceRefs: ["invented-ref"] } };
	state = await advance(state, h.host);
	assert.equal(state.phase, "blocked");
	assert.match(state.note, /evidence/);
});

test("pending probe is never silently replayed after a lost response", async () => {
	const h = harness();
	let calls = 0;
	h.host.runProbe = async () => {
		calls++;
		throw new Error("response lost after action");
	};
	let state = await advance(initial(), h.host);
	state = await advance(state, h.host);
	assert.equal(state.phase, "pending-probe");
	assert.equal(calls, 1);
	state = await advance(state, h.host);
	assert.equal(calls, 1);
	const pending = state.pending!;
	state = await reconcile(
		state,
		{
			runId: pending.runId,
			outcome: "unknown",
			summary: "Host could not establish outcome.",
			evidence: [evidence("reconciliation")],
		},
		h.host,
	);
	assert.equal(state.phase, "investigate");
	assert.equal(state.probes[0].observation.outcome, "unknown");
});

test("out-of-scope new task does not invalidate the method globally", async () => {
	const h = harness();
	let state = await learned(h);
	h.host.checkApplicability = async () => ({ met: false, evidence: [evidence("unsupported-image")] });
	h.replies.push(useReply);
	state = await tryMethod(state, task, h.host);
	assert.equal(state.phase, "trial-ready");
	assert.equal(state.trials.at(-1)?.status, "out-of-scope");
	assert.equal(h.uses.length, 0);
});

test("declining a method records an opportunity, without executing it", async () => {
	const h = harness();
	let state = await learned(h);
	h.replies.push({ decision: "deliberate", reason: "This task needs a different approach.", adaptation: [] });
	state = await tryMethod(state, task, h.host);
	assert.equal(state.trials.at(-1)?.status, "declined");
	assert.equal(h.uses.length, 0);
});

test("two concurrent drivers cannot both pass the save compare-and-swap", async () => {
	const h = harness();
	const results = await Promise.allSettled([advance(initial(), h.host), advance(initial(), h.host)]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(h.requests.length, 1);
});

test("thought and probe limits stop before the next action", async () => {
	const h = harness();
	let state = startInquiry("inquiry-1", [experience], { thoughts: 1, probes: 0 });
	state = await advance(state, h.host);
	state = await advance(state, h.host);
	assert.equal(state.phase, "deferred");
	assert.match(state.note, /budget/);
	assert.equal(h.requests.length, 1);
	assert.equal(h.probes.length, 0);
});

test("training tasks cannot be relabeled as held-out evaluation", async () => {
	const h = harness();
	const review = h.host.review;
	h.host.review = async (...args) => ({ ...(await review(...args)), heldOutTaskIds: ["training-1"] });
	let state = initial();
	for (let i = 0; i < 4; i++) state = await advance(state, h.host);
	assert.equal(state.phase, "blocked");
	assert.match(state.note, /held.out/);
});

test("self-reported success without host evidence is not accepted", async () => {
	const h = harness();
	h.host.runProbe = async (request) => ({
		runId: request.runId,
		outcome: "success",
		summary: "I passed",
		evidence: [],
	});
	let state = await advance(initial(), h.host);
	state = await advance(state, h.host);
	assert.equal(state.phase, "pending-probe");
	assert.equal(state.probes.length, 0);
	assert.match(state.note, /evidence/);
});

test("wrong method/task receipt stays pending and cannot suspend another version", async () => {
	const h = harness();
	let state = await learned(h);
	const use = h.host.runUse;
	h.host.runUse = async (...args) => ({ ...(await use(...args)), methodId: "another-version" });
	h.replies.push(useReply);
	state = await tryMethod(state, task, h.host);
	assert.equal(state.phase, "pending-use");
	assert.equal(state.method?.status, "trial-ready");
});

test("permission denial stops a proposed probe", async () => {
	const h = harness();
	h.host.authorizeProbe = async () => false;
	let state = await advance(initial(), h.host);
	state = await advance(state, h.host);
	assert.equal(state.phase, "deferred");
	assert.match(state.note, /authoriz/);
	assert.equal(h.probes.length, 0);
});

test("failed independent review cannot activate a candidate", async () => {
	const h = harness();
	const review = h.host.review;
	h.host.review = async (...args) => ({ ...(await review(...args)), decision: "rejected" });
	let state = initial();
	for (let i = 0; i < 4; i++) state = await advance(state, h.host);
	assert.equal(state.phase, "deferred");
	assert.equal(state.method?.status, "candidate");
	assert.equal(h.uses.length, 0);
});

test("cancellation before a call prevents both reasoning and action", async () => {
	const h = harness();
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(advance(initial(), h.host, controller.signal), /abort/i);
	assert.equal(h.requests.length, 0);
});

test("probe port can return actual filesystem observations; driver does not score them", async () => {
	const dir = await mkdtemp(join(tmpdir(), "her-growth-test-"));
	try {
		const path = join(dir, "sample.txt");
		await writeFile(path, "a,b\n1,2\n", "utf8");
		const h = harness();
		h.host.runProbe = async (request) => {
			const text = await readFile(path, "utf8");
			return {
				runId: request.runId,
				outcome: "success",
				summary: text,
				evidence: [evidence("probe-evidence", text)],
			};
		};
		let state = await advance(initial(), h.host);
		state = await advance(state, h.host);
		assert.equal(state.probes[0].observation.summary, "a,b\n1,2\n");
		assert.equal(state.probes[0].observation.evidence[0].digest, hash("a,b\n1,2\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("review is reserved once; interrupted review requires explicit host reconciliation", async () => {
	const h = harness();
	let state = initial();
	for (let i = 0; i < 3; i++) state = await advance(state, h.host);
	let calls = 0;
	const normalReview = h.host.review;
	h.host.review = async () => {
		calls++;
		throw new Error("review result channel lost");
	};
	state = await advance(state, h.host);
	assert.equal(state.phase, "pending-review");
	state = await advance(state, h.host);
	assert.equal(calls, 1);
	state = await reconcileReview(state, await normalReview(state.method!, []), h.host);
	assert.equal(state.phase, "trial-ready");
});

test("missing precondition evidence blocks use even when the model recommends it", async () => {
	const h = harness();
	let state = await learned(h);
	h.replies.push(useReply);
	h.host.checkApplicability = async () => ({ met: true, evidence: [] });
	state = await tryMethod(state, task, h.host);
	assert.equal(state.phase, "blocked");
	assert.equal(h.uses.length, 0);
});

test("permission for a new task is not inherited from approval of a method", async () => {
	const h = harness();
	let state = await learned(h);
	h.replies.push(useReply);
	h.host.authorizeUse = async () => false;
	state = await tryMethod(state, task, h.host);
	assert.equal(state.trials.at(-1)?.status, "denied");
	assert.equal(h.uses.length, 0);
});

test("cancel during durable reservation prevents probe execution", async () => {
	const h = harness();
	const control = new AbortController();
	const save = h.host.save;
	h.host.save = async (...args) => {
		await save(...args);
		if (args[0].phase === "pending-probe") control.abort();
	};
	let state = await advance(initial(), h.host, control.signal);
	state = await advance(state, h.host, control.signal);
	assert.equal(state.phase, "pending-probe");
	assert.equal(h.probes.length, 0);
	assert.match(state.note, /abort/i);
});

test("reopening does not silently replenish the research budget or discard history", async () => {
	const h = harness([{ decision: "defer", reason: "Awaiting new facts." }]);
	let state = await advance(initial(), h.host);
	const spent = structuredClone(state.spent);
	state = await reopen(
		state,
		[
			{
				...experience,
				id: "experience-new",
				taskId: "training-new",
			},
		],
		h.host,
	);
	assert.deepEqual(state.spent, spent);
	assert.equal(state.experiences.length, 2);
	assert.equal(state.experiences[0].id, experience.id);
});

test("model adapter uses the injected model and token cap, not its own provider or credentials", async () => {
	const calls: Array<{ prompt: string; tokens: number | undefined }> = [];
	const reason = createReasoner(
		{
			complete: (prompt, options) => {
				calls.push({ prompt, tokens: options?.maxTokens });
				return '{"decision":"defer","reason":"not worth investigating"}';
			},
		},
		768,
	);
	const result = await reason({ stage: "discover", instruction: "Return JSON", data: { observation: "example" } });
	assert.deepEqual(result, { decision: "defer", reason: "not worth investigating" });
	assert.equal(calls[0].tokens, 768);
	assert.match(calls[0].prompt, /example/);
});

test("model adapter rejects malformed output without a repair loop or extra calls", async () => {
	let calls = 0;
	const reason = createReasoner(
		{
			complete: () => {
				calls++;
				return "I already passed all tests";
			},
		},
		768,
	);
	await assert.rejects(reason({ stage: "discover", instruction: "JSON", data: {} }), SyntaxError);
	assert.equal(calls, 1);
});

test("held-out review record is not included in later model prompts", async () => {
	const h = harness();
	let state = await learned(h);
	h.replies.push(useReply);
	state = await tryMethod(state, task, h.host);
	assert.equal(state.phase, "trial-ready");
	const prompts = JSON.stringify(h.requests);
	assert.doesNotMatch(prompts, /heldout-1|independent-review/);
});

test("durable host snapshots survive a new object without rewriting earlier records", async () => {
	const dir = await mkdtemp(join(tmpdir(), "her-growth-journal-"));
	try {
		const h = harness();
		const file = join(dir, "trace.md");
		const originalSave = h.host.save;
		let markdown = "# Synthetic engineering trace\n\n";
		h.host.save = async (next, expected) => {
			await originalSave(next, expected);
			// This is a test host only. Production must use Her's existing single writer + lock/CAS.
			markdown += `## Revision ${next.revision}\n\n\`\`\`json\n${JSON.stringify(next)}\n\`\`\`\n\n`;
			await writeFile(file, markdown, "utf8");
		};
		let state = await advance(initial(), h.host);
		const firstBytes = await readFile(file, "utf8");
		state = JSON.parse(JSON.stringify(state)) as GrowthState;
		state = await advance(state, h.host);
		const laterBytes = await readFile(file, "utf8");
		assert.ok(laterBytes.startsWith(firstBytes), "earlier snapshots must be preserved");
		assert.equal(state.probes.length, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("missing budgets cannot turn limits into an unbounded loop", () => {
	assert.throws(() => startInquiry("inquiry-1", [experience], {} as { thoughts: number; probes: number }), /budget/);
});
test("inquiry ids cannot masquerade as filesystem paths", () => {
	assert.throws(() => startInquiry("../other", [experience], { thoughts: 2, probes: 1 }), /inquiry id/);
});
