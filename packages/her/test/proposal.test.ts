import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initStore, readText } from "../src/her-core/index.ts";
import {
	listHerProposals,
	recordHerProposal,
	recordHerProposalFeedback,
	summarizeHerProposalStats,
} from "../src/her-core/proposal.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-proposal-"));
	await initStore(root);
	return root;
}

test("Her proposals persist scan suggestions and track adoption stats", async () => {
	const store = await tempStore();

	const first = await recordHerProposal(store, {
		id: "proposal-readme",
		title: "README install drift",
		observation: "The README install command no longer matches package scripts.",
		suggestion: "Update the install section before the next handoff.",
		evidence: ["package.json exposes npm run check"],
		source: "her-scan",
		now: "2026-06-13T10:00:00.000Z",
	});
	assert.equal(first.status, "open");
	assert.equal(first.path, "proposals/scan/proposal-readme.md");

	await recordHerProposal(store, {
		id: "proposal-evals",
		title: "Add eval baseline",
		observation: "Phase E expects a baseline before more autonomy.",
		suggestion: "Create eval fixtures before heartbeats start.",
		evidence: ["Phase E E3 mentions baseline"],
		source: "her-scan",
		now: "2026-06-13T10:05:00.000Z",
	});
	await recordHerProposal(store, {
		id: "proposal-too-noisy",
		title: "Message Fei five times",
		observation: "There are several minor possible cleanups.",
		suggestion: "Send separate pushes for each cleanup.",
		evidence: ["outbox has multiple ideas"],
		source: "her-scan",
		now: "2026-06-13T10:10:00.000Z",
	});

	const accepted = await recordHerProposalFeedback(store, "proposal-readme", {
		verdict: "do",
		note: "Good catch; do this.",
		now: "2026-06-13T10:15:00.000Z",
	});
	assert.equal(accepted.status, "accepted");
	assert.equal(accepted.feedback[0]?.verdict, "do");

	await recordHerProposalFeedback(store, "proposal-evals", {
		verdict: "later",
		note: "Useful but not before D is done.",
		now: "2026-06-13T10:20:00.000Z",
	});
	await recordHerProposalFeedback(store, "proposal-too-noisy", {
		verdict: "wrong",
		note: "Too noisy.",
		now: "2026-06-13T10:25:00.000Z",
	});

	const stats = await summarizeHerProposalStats(store);
	assert.equal(stats.total, 3);
	assert.equal(stats.accepted, 1);
	assert.equal(stats.deferred, 1);
	assert.equal(stats.rejected, 1);
	assert.equal(stats.adoptionRate, 1 / 3);
	assert.equal(stats.suggestedMode, "normal");

	const proposals = await listHerProposals(store);
	assert.deepEqual(
		proposals.map((proposal) => [proposal.id, proposal.status]),
		[
			["proposal-too-noisy", "rejected"],
			["proposal-evals", "deferred"],
			["proposal-readme", "accepted"],
		],
	);
	assert.match((await readText(join(store, "proposals", "scan", "proposal-readme.md"))) ?? "", /Good catch/);
});

test("Her proposal stats become conservative after repeated rejection", async () => {
	const store = await tempStore();
	for (const id of ["first", "second", "third"]) {
		await recordHerProposal(store, {
			id,
			title: id,
			observation: `Observed ${id}.`,
			suggestion: `Suggest ${id}.`,
			evidence: [`Evidence ${id}.`],
			source: "her-scan",
		});
		await recordHerProposalFeedback(store, id, { verdict: "wrong", note: "Not useful." });
	}

	const stats = await summarizeHerProposalStats(store);
	assert.equal(stats.rejectionStreak, 3);
	assert.equal(stats.suggestedMode, "conservative");
});
