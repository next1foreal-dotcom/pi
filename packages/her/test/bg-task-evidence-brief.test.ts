import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGatePlan } from "../src/her-core/bg-task-acceptance.ts";
import { appendEvidenceVerifiedBrief } from "../src/her-core/bg-task-spawn.ts";
import { buildPanelChairBrief } from "../src/her-core/panel-chair-brief.ts";

const evidencePlan = parseGatePlan(
	{ gates: [{ name: "evidence", type: "evidence-verified", command: [process.execPath, "-e", "0"] }] },
	"task",
);

test("G-223 ordinary worker brief gets one machine-checkable evidence contract", () => {
	const brief = appendEvidenceVerifiedBrief("Do the work.", evidencePlan);
	assert.match(brief, /```json evidence\n/);
	assert.match(brief, /\"file\":\s*\"relative\/path\"/);
	assert.match(brief, /\"lines\":\s*\"12-14\"/);
	assert.match(brief, /\"claim\":\s*\"what the cited lines prove\"/);
	assert.match(brief, /machine-checkable item by item/i);
	assert.match(brief, /no evidence, say so truthfully/i);
});

test("G-223 leaves briefs without an evidence gate unchanged", () => {
	const brief = "Do the work.\n";
	const plan = parseGatePlan({ gates: [{ name: "command", command: [process.execPath, "-e", "0"] }] }, "task");
	assert.equal(appendEvidenceVerifiedBrief(brief, plan), brief);
	assert.equal(appendEvidenceVerifiedBrief(brief, null), brief);
});

test("G-223 does not duplicate a panel-chair or existing machine contract", () => {
	const panelBrief = buildPanelChairBrief({ objective: "review" });
	assert.equal(appendEvidenceVerifiedBrief(panelBrief, evidencePlan), panelBrief);
	const existing = [
		"Do the work.",
		"MACHINE CONTRACT: evidence-verified",
		"```json evidence",
		"[{\"file\":\"relative/path\",\"claim\":\"what the cited lines prove\"}]",
		"```",
	].join("\n");
	assert.equal(appendEvidenceVerifiedBrief(existing, evidencePlan), existing);
});
