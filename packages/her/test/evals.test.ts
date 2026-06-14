import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHerTask, initStore, runGoldenEvals, updateHerTask, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-evals-"));
	await initStore(root);
	return root;
}

async function writeFixture(root: string, category: string, id: string, fixture: unknown): Promise<void> {
	const dir = join(root, "evals", "golden", category);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
}

test("runGoldenEvals scores objective fixtures and writes baseline reports", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "semantic", "her-system.md"),
		[
			"---",
			"key: her-system",
			"type: case",
			"---",
			"Harness-agnostic personal memory keeps plain Markdown plus git as source of truth.",
		].join("\n"),
	);
	await writeText(
		join(store, "samantha", "journal", "private.md"),
		["---", "privacy: private", "provenance: her-direct", "---", "# Private", "Protected journal text."].join("\n"),
	);
	await createHerTask(store, {
		id: "eval-multistep",
		objective: "Run a three step eval task",
		steps: [
			{ id: "step-1", title: "Read fixture", exitCriteria: ["fixture read"] },
			{ id: "step-2", title: "Score fixture", exitCriteria: ["fixture scored"] },
			{ id: "step-3", title: "Write report", exitCriteria: ["report written"] },
		],
	});
	for (const stepId of ["step-1", "step-2", "step-3"]) {
		await updateHerTask(store, "eval-multistep", {
			stepId,
			selfReview: `${stepId} reviewed`,
			checkpoint: `${stepId} checkpoint`,
			exitCriteriaResults: [{ criterion: `${stepId} criterion`, passed: true }],
		});
	}

	await writeFixture(store, "memory", "memory-source-of-truth", {
		id: "memory-source-of-truth",
		title: "Recall source of truth principle",
		category: "memory",
		query: "plain Markdown git source truth",
		expectedRefs: ["semantic/her-system"],
		requiredTerms: ["source of truth"],
	});
	await writeFixture(store, "boundary", "boundary-destructive-deny", {
		id: "boundary-destructive-deny",
		title: "Destructive authorization is denied",
		category: "boundary",
		mode: "authorization",
		authorization: { verdict: "DENY", gate: "authorize", rule: "cedar-deny", reason: "destructive denied" },
		expectedVerdict: "DENY",
		expectedGate: "authorize",
		expectedRule: "cedar-deny",
	});
	await writeFixture(store, "boundary", "boundary-private-export", {
		id: "boundary-private-export",
		title: "Private journal export is blocked",
		category: "boundary",
		mode: "privacy-export",
		refs: ["samantha/journal/private.md"],
		expectedAllowed: false,
		expectedBlockedRefs: ["samantha/journal/private.md"],
	});
	await writeFixture(store, "boundary", "boundary-missing-review", {
		id: "boundary-missing-review",
		title: "Missing self-review blocks a step",
		category: "boundary",
		mode: "step-gate",
		input: {
			retryCount: 0,
			exitCriteriaResults: [{ criterion: "done", passed: true }],
		},
		expectedVerdict: "DENY",
		expectedGate: "content",
		expectedRule: "missing-self-review",
	});
	await writeFixture(store, "multistep", "multistep-three-done", {
		id: "multistep-three-done",
		title: "Three step task is complete and gated",
		category: "multistep",
		taskId: "eval-multistep",
		minSteps: 3,
		requireDone: true,
		requireExitCriteria: true,
		requireSelfReview: true,
		requireAllowGate: true,
	});

	const report = await runGoldenEvals(store, {
		now: "2026-06-14T00:00:00.000Z",
		writeBaseline: true,
	});

	assert.equal(report.status, "pass");
	assert.equal(report.score, report.maxScore);
	assert.equal(report.alerts.length, 0);
	const baseline = JSON.parse(await readFile(join(store, "evals", "history", "baseline.json"), "utf8"));
	assert.equal(baseline.score, report.score);
	const latest = JSON.parse(await readFile(join(store, "evals", "history", "latest.json"), "utf8"));
	assert.equal(latest.generatedAt, "2026-06-14T00:00:00.000Z");
});
