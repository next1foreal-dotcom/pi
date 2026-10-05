import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type GrowthHostPlan, HerGrowthHost } from "../../src/growth-experiment/host.ts";
import { startInquiry } from "../../src/growth-experiment/loop.ts";
import { sha256 } from "../../src/her-core/improvement-plan.ts";
import { FakeModel } from "../../src/her-core/model.ts";
import { authorizePilotFixture } from "./growth-pilot-owner.ts";
// Preset replies test the real journal/executor wiring only, not learning.
export const original = {
	id: "original",
	taskId: "old-task",
	expectation: "original raw task",
	observation: "original failure",
	evidence: [
		{
			ref: "old.txt",
			digest: sha256("original failure"),
			origin: "environment" as const,
			summary: "original failure",
		},
	],
};
export async function fixture(
	t: TestContext,
	mode = "use",
	provider = "api.deepseek.com",
	configure?: (plan: GrowthHostPlan, root: string) => void | Promise<void>,
	fresh = false,
	withPilotAuthorization = true,
	initialize = true,
) {
	const root = await mkdtemp(join(tmpdir(), "her-growth-task-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source =
		'import {readFileSync} from "node:fs";const r=JSON.parse(readFileSync(0,"utf8"));console.log(JSON.stringify({value:r.answer??r,met:r.task?.environment==="text"}));';
	await mkdir(join(root, "evals"));
	await writeFile(join(root, "evals/op.mjs"), source);
	await writeFile(join(root, "old.txt"), "original failure");
	const task = (id: string, environment = "text") => ({
		id,
		description: `task ${id}`,
		environment,
		input: { marker: id },
		expected: { ok: true },
	});
	const plan: GrowthHostPlan = {
		version: 1,
		inquiryId: "inquiry",
		approvedBy: "offline engineering fixture",
		expiresAt: new Date(Date.now() + 120000).toISOString(),
		model: {
			request: "deepseek-v4-flash",
			reported: ["deepseek-v4-flash"],
			provider,
			maxOutputTokens: 128,
			inputUsdPerMillion: 0.3,
			outputUsdPerMillion: 1.2,
			requestOptions: { requireComplete: true },
		},
		budget: { tokens: 100000, usd: 1, wallMs: 120000, processMs: 10000, outputBytes: 65536, requests: 32 },
		operations: {
			observe: {
				file: "evals/op.mjs",
				sha256: sha256(source),
				purposes: ["probe", "applicability", "use", "review"],
			},
		},
		applicabilityOperation: "observe",
		useOperation: "observe",
		reviewOperation: "observe",
		tasks: [task("development"), task("final"), task("boundary", "binary")],
		review: {
			minGain: 0.5,
			cases: [
				{ ...task("holdout"), split: "holdout" },
				{ ...task("regression"), split: "regression" },
			],
		},
		correction: {
			developmentTaskIds: ["development"],
			review: {
				minGain: 0.5,
				cases: [
					{ ...task("holdout-v2"), split: "holdout" },
					{ ...task("regression-v2"), split: "regression" },
				],
			},
		},
	};
	await configure?.(plan, root);

	if (provider !== "api.deepseek.com") {
		await mkdir(join(root, ".her"));
		await writeFile(
			join(root, ".her/config.yaml"),
			`llm:\n  base_url: http://${provider}\n  model_fast: deepseek-v4-flash\n  api_key_env: TEST_TASK_KEY\n`,
		);
	}
	if (plan.pilot && withPilotAuthorization) await authorizePilotFixture(root, plan, [original]);
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	const model = new FakeModel("{}", false);
	model.completeWithMeta = (prompt, options) => {
		model.calls.push({ prompt, maxTokens: options?.maxTokens, strong: false });
		assert.equal(options?.singleRequest, true);
		const selecting = prompt.includes("Untrusted input as JSON:");
		const text = selecting
			? mode === "bad-selection"
				? "null"
				: JSON.stringify({
						decision: mode === "decline" ? "deliberate" : "use",
						reason: "fixture choice",
						adaptation: mode === "decline" ? [] : ["fixture adaptation"],
					})
			: JSON.stringify({ ok: mode !== "wrong" });
		return {
			text,
			model: plan.model.request,
			provider: plan.model.provider,
			finishReason: "stop",
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
		};
	};
	const host = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	const initial = startInquiry("inquiry", [original], { thoughts: 12, probes: 2 });
	const method = {
		id: sha256("fixture method"),
		status: "trial-ready" as const,
		draft: {
			name: "fixture method",
			problem: "fixture",
			preconditions: ["text"],
			steps: ["fixture"],
			stopWhen: ["unknown"],
			counterexamples: ["binary"],
			sourceEvidenceRefs: ["old.txt"],
		},
		review: {
			methodId: sha256("fixture method"),
			planDigest: host.planDigest,
			decision: "eligible-for-review" as const,
			heldOutTaskIds: ["holdout", "regression"],
			evidence: original.evidence,
		},
	};
	if (initialize) await host.save(fresh ? initial : { ...initial, phase: "trial-ready", method }, -1);
	return { root, host, model };
}
