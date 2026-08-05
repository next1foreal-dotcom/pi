import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	acceptanceRunFilename,
	EVIDENCE_GATE_NAME,
	evaluateTaskAcceptance,
	extractEvidenceItems,
	extractJsonlText,
	gatePlanFilename,
} from "../src/her-core/bg-task-acceptance.ts";

const fence = String.fromCharCode(96).repeat(3);
const taskId = "t-evidence-source";
const command = [process.execPath, "-e", "0"];

function evidenceBlock(items: unknown): string {
	return [`${fence}json evidence`, JSON.stringify(items), fence].join("\n");
}

const validItems = [
	{ file: "source.ts", lines: "1", claim: "answer exists" },
	{ file: "source.ts", lines: "2", claim: "second line exists" },
];

const codexJsonlFixture = [
	JSON.stringify({
		type: "item.completed",
		item: {
			id: "item_5",
			type: "agent_message",
			text: [
				"Defect exists: `src/get-path.js:10` uses `cur || fallback` and treats valid falsy values as missing.",
				evidenceBlock([
					{
						file: "src/get-path.js",
						lines: "10-10",
						claim: "`return cur || fallback;` treats 0, false, and an empty string as missing because they are falsy, returning the fallback instead.",
					},
					{
						file: "test/basic.test.js",
						lines: "10-14",
						claim: "The getPath tests cover a truthy nested value and a missing path, but not legitimate falsy values.",
					},
				]),
			].join("\n"),
		},
	}),
].join("\n");

async function acceptanceFixture(opts: { result?: string; log?: string; sourceFiles?: Record<string, string> }) {
	const root = await mkdtemp(join(tmpdir(), "her-evidence-source-"));
	await writeFile(
		join(root, gatePlanFilename(taskId)),
		JSON.stringify({
			source: "task",
			gates: [{ name: EVIDENCE_GATE_NAME, type: "evidence-verified", command }],
		}),
		"utf8",
	);
	await writeFile(
		join(root, acceptanceRunFilename(taskId)),
		JSON.stringify({
			gates: [
				{
					name: EVIDENCE_GATE_NAME,
					command,
					exitCode: 0,
					outputDigest: "sha256:evidence",
					outputBytes: 0,
					outputHead: "",
					logPath: `${taskId}.log`,
					durationMs: 1,
				},
			],
			startedAt: "2026-08-05T00:00:00.000Z",
			endedAt: "2026-08-05T00:00:01.000Z",
		}),
		"utf8",
	);
	if (opts.result !== undefined) await writeFile(join(root, `${taskId}.result.md`), opts.result, "utf8");
	if (opts.log !== undefined) await writeFile(join(root, `${taskId}.log`), opts.log, "utf8");
	for (const [file, content] of Object.entries(opts.sourceFiles ?? {})) {
		const path = join(root, file);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	return root;
}

async function evaluateFixture(opts: { result?: string; log?: string; sourceFiles?: Record<string, string> }) {
	const root = await acceptanceFixture(opts);
	return evaluateTaskAcceptance({ taskDir: root, taskId, workerCwd: root });
}

test("G-223 real codex JSONL item.text restores the fenced block and two evidence items", async () => {
	const extracted = extractEvidenceItems(extractJsonlText(codexJsonlFixture));
	assert.equal(extracted.length, 2);
	assert.equal(extracted[0]?.file, "src/get-path.js");
	assert.equal(extracted[1]?.file, "test/basic.test.js");

	const outcome = await evaluateFixture({
		log: codexJsonlFixture,
		sourceFiles: {
			"src/get-path.js": Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"),
			"test/basic.test.js": Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n"),
		},
	});
	assert.equal(outcome.verdict, "green");
});

test("result.md is preferred when it contains evidence", async () => {
	const outcome = await evaluateFixture({
		result: evidenceBlock(validItems),
		log: "plain runner log without evidence",
		sourceFiles: { "source.ts": "const answer = 42;\nsecond line\n" },
	});
	assert.equal(outcome.verdict, "green");
});

test("result.md is authoritative and refuses missing evidence instead of falling back to raw log", async () => {
	const outcome = await evaluateFixture({
		result: "worker summary without an evidence block",
		log: evidenceBlock(validItems),
		sourceFiles: { "source.ts": "const answer = 42;\nsecond line\n" },
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	const detail = outcome.reasons.find((reason) => reason.code === "missing_evidence")?.detail ?? "";
	assert.match(detail, /result file exists/);
	assert.match(detail, /no evidence block found/);
	assert.match(detail, /raw log and jsonl log were not consulted/);
});

test("a result.md evidence block with no items is rejected instead of falling back to raw log", async () => {
	const outcome = await evaluateFixture({
		result: evidenceBlock([]),
		log: evidenceBlock(validItems),
		sourceFiles: { "source.ts": "const answer = 42;\nsecond line\n" },
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	const detail = outcome.reasons.find((reason) => reason.code === "missing_evidence")?.detail ?? "";
	assert.match(detail, /result file exists but contains no evidence items/);
	assert.match(detail, /raw log and jsonl log were not consulted/);
});

test("an empty result.md is rejected instead of falling back to raw log", async () => {
	const outcome = await evaluateFixture({
		result: "",
		log: evidenceBlock(validItems),
		sourceFiles: { "source.ts": "const answer = 42;\nsecond line\n" },
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	const detail = outcome.reasons.find((reason) => reason.code === "missing_evidence")?.detail ?? "";
	assert.match(detail, /result file exists but is empty/);
	assert.match(detail, /raw log and jsonl log were not consulted/);
});

test("plain raw log evidence still passes without result.md", async () => {
	const outcome = await evaluateFixture({
		log: evidenceBlock([{ file: "source.ts", lines: "1", claim: "answer exists" }]),
		sourceFiles: { "source.ts": "const answer = 42;\n" },
	});
	assert.equal(outcome.verdict, "green");
});

test("missing evidence names result file, raw log, and jsonl log when result.md is absent", async () => {
	const outcome = await evaluateFixture({
		log: JSON.stringify({ type: "item.completed", item: { text: "still no evidence" } }),
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	const detail = outcome.reasons.find((reason) => reason.code === "missing_evidence")?.detail ?? "";
	assert.match(detail, /result file/);
	assert.match(detail, /raw log/);
	assert.match(detail, /jsonl log/);
});

test("evidence extraction does not relax verifyEvidence", async () => {
	const outcome = await evaluateFixture({
		result: evidenceBlock([{ file: "does-not-exist.ts", lines: "1", claim: "missing file" }]),
		log: "no evidence",
	});
	assert.equal(outcome.verdict, "rejected-needs-evidence");
	assert.ok(outcome.reasons.some((reason) => reason.code === "evidence_unverified"));
});
