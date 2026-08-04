import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	BUILTIN_WORKER_PROFILES,
	buildWorkerEnv,
	createPanelChairWorkerProfile,
	resolvePanelChairCliPath,
} from "../src/her-core/worker-profile.ts";
import { buildPanelChairBrief } from "../src/her-core/panel-chair-brief.ts";
import {
	EVIDENCE_GATE_NAME,
	judgeAcceptance,
	parseGatePlan,
	type AcceptanceRun,
	type GateRun,
	verifyEvidenceGate,
} from "../src/her-core/bg-task-acceptance.ts";

const EXECUTOR_RULE = "ROLE: EXECUTOR \u2014 do the work yourself; do not spawn subagents.";

function evidenceBlock(items: unknown): string {
	const fence = String.fromCharCode(96).repeat(3);
	return [`${fence}json evidence`, JSON.stringify(items), fence].join("\n");
}

function gateRun(command: string[]): GateRun {
	return {
		name: EVIDENCE_GATE_NAME,
		command,
		exitCode: 0,
		outputDigest: "sha256:evidence",
		outputBytes: 0,
		outputHead: "",
		logPath: "evidence.log",
		durationMs: 1,
	};
}

function evidenceRun(command: string[]): AcceptanceRun {
	return { gates: [gateRun(command)], startedAt: "2026-08-04T00:00:00.000Z", endedAt: "2026-08-04T00:00:01.000Z" };
}

test("panel-chair invocation uses the deer CLI fallback order and required flags", () => {
	const override = resolve("packages/coding-agent/custom-cli.js");
	const profile = createPanelChairWorkerProfile({ HER_DISPATCH_PI_CLI: override });
	assert.deepEqual(profile.argv, [process.execPath, override, "-p", "--mode", "json", "--no-session"]);
	assert.equal(resolvePanelChairCliPath({ HER_DISPATCH_PI_CLI: override }), override);
	assert.match(createPanelChairWorkerProfile({}).argv[1] ?? "", /packages[\\/]coding-agent[\\/]dist[\\/]cli\\.js$/);
	assert.equal(profile.cwd, BUILTIN_WORKER_PROFILES["panel-chair"]?.cwd);
});

test("panel-chair strips stale DEEPSEEK_API_KEY while other profiles keep env behavior", () => {
	const previous = process.env.DEEPSEEK_API_KEY;
	process.env.DEEPSEEK_API_KEY = "stale-test-key";
	try {
		const panel = buildWorkerEnv(createPanelChairWorkerProfile(), "t-panel");
		assert.equal(panel.DEEPSEEK_API_KEY, undefined);
		const other = buildWorkerEnv({ argv: ["node"], envAllow: ["DEEPSEEK_API_KEY"] }, "t-other");
		assert.equal(other.DEEPSEEK_API_KEY, "stale-test-key");
	} finally {
		if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previous;
	}
});

test("panel-chair brief hard-locks the four review contract elements", () => {
	const brief = buildPanelChairBrief({ objective: "review the task", memberBrief: "inspect the changed files" });
	assert.match(brief, /ROLE: PANEL CHAIR/);
	assert.equal(brief.split(EXECUTOR_RULE).length - 1, 1);
	assert.match(brief, /PANEL_FAIL:/);
	assert.match(brief, /delegate/);
	assert.match(brief, /her_review_verify/);
	assert.match(brief, /evidence\(file\+lines\)/);
	assert.match(brief, /member session/);
});

test("evidence-verified gate passes only when every extracted item verifies", () => {
	const cwd = mkdtempSync(join(tmpdir(), "her-panel-chair-"));
	writeFileSync(join(cwd, "source.ts"), ["export const answer = 42;", ""].join("\n"), "utf8");
	const plan = parseGatePlan({ gates: [{ name: EVIDENCE_GATE_NAME, type: "evidence-verified" }] }, "task");
	const evidence = evidenceBlock([{ file: "source.ts", lines: "1", claim: "answer exists" }]);
	const result = verifyEvidenceGate(evidence, cwd);
	assert.equal(result.verified, true);
	const outcome = judgeAcceptance({
		plan,
		run: evidenceRun(plan.gates[0]!.command),
		report: null,
		evidenceOutput: evidence,
		evidenceCwd: cwd,
	});
	assert.equal(outcome.verdict, "green");
});

test("evidence-verified gate fails loud for false and empty evidence", () => {
	const cwd = mkdtempSync(join(tmpdir(), "her-panel-chair-"));
	const plan = parseGatePlan({ gates: [{ name: EVIDENCE_GATE_NAME, type: "evidence-verified" }] }, "task");
	const command = plan.gates[0]!.command;
	const falseOutcome = judgeAcceptance({
		plan,
		run: evidenceRun(command),
		report: null,
		evidenceOutput: evidenceBlock([{ file: "missing.ts", lines: "1", claim: "missing" }]),
		evidenceCwd: cwd,
	});
	assert.equal(falseOutcome.verdict, "rejected-needs-evidence");
	assert.ok(falseOutcome.reasons.some((reason) => reason.detail.includes("missing.ts")));
	const emptyOutcome = judgeAcceptance({
		plan,
		run: evidenceRun(command),
		report: null,
		evidenceOutput: "PANEL_OK without an evidence block",
		evidenceCwd: cwd,
	});
	assert.equal(emptyOutcome.verdict, "rejected-needs-evidence");
	assert.ok(emptyOutcome.reasons.some((reason) => /no evidence/i.test(reason.detail)));
});

test("the change set does not touch G-221 protected files", () => {
	const changed = execFileSync("git", ["diff", "--name-only"], { encoding: "utf8" });
	for (const file of ["bg-task-spawn.ts", "bg-task-reconcile.ts", "extension.ts", "task-executor.ts", "task-runner.mjs"]) {
		assert.equal(changed.includes(file), false, `${file} is protected`);
	}
});