import assert from "node:assert/strict";
import { test } from "node:test";
import {
	allVerified,
	applyVerifierDecision,
	classifyStall,
	emptyProgressState,
	formatProgressCheckpoint,
	requirementStatus,
	statusFromDoneEvidence,
	withRequirements,
} from "../src/her-core/progress-state.ts";

test("only verifier commits progress; actor claims stay pending", () => {
	let s = withRequirements(emptyProgressState(), [
		{ id: "map", check: "Map notes non-empty" },
		{ id: "wire", check: "Wire plan produced" },
		{ id: "verify", check: "Gate exit 0 and adversarial keep" },
	]);
	assert.equal(requirementStatus(s, "map"), "pending");
	assert.equal(allVerified(s), false);

	s = applyVerifierDecision(s, {
		action: "verify",
		requirementIds: ["map"],
		evidence: { kind: "artifact", summary: "2 lanes with hits" },
		values: [{ key: "laneCount", value: "2", fromRequirement: "map" }],
	});
	assert.equal(requirementStatus(s, "map"), "verified");
	assert.equal(requirementStatus(s, "verify"), "pending");
	assert.equal(s.values[0]?.value, "2");
});

test("invalidate blocks DONE and classifies conflict", () => {
	let s = withRequirements(emptyProgressState(), [{ id: "verify", check: "tests green" }]);
	s = applyVerifierDecision(s, {
		action: "invalidate",
		requirementIds: ["verify"],
		evidence: { kind: "gate", summary: "exitCode=1" },
	});
	assert.equal(requirementStatus(s, "verify"), "invalidated");
	assert.equal(allVerified(s), false);
	assert.equal(classifyStall(s), "conflicting_evidence");
});

test("statusFromDoneEvidence: .done beats stale running claim", () => {
	assert.equal(statusFromDoneEvidence("running", { exitCode: 0 }), "completed");
	assert.equal(statusFromDoneEvidence("pending", { exitCode: 1 }), "failed");
	assert.equal(statusFromDoneEvidence("running", null), "running");
});

test("checkpoint is human-readable", () => {
	let s = withRequirements(emptyProgressState(), [{ id: "gate", check: "exit 0" }]);
	s = applyVerifierDecision(
		s,
		{
			action: "verify",
			requirementIds: ["gate"],
			evidence: { kind: "shell", summary: "exitCode=0", at: "2026-07-28T00:00:00.000Z" },
		},
		new Date("2026-07-28T00:00:00.000Z"),
	);
	const md = formatProgressCheckpoint(s);
	assert.match(md, /\[verified\] `gate`/);
	assert.match(md, /shell · exitCode=0/);
});
