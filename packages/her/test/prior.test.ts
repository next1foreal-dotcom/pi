import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import {
	assemblePrior,
	initStore,
	Memory,
	priorModeForAction,
	readText,
	recordPriorAudit,
	resolvePriorMode,
	writeText,
} from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-prior-"));
	await initStore(root);
	return root;
}

async function writePriorFixture(store: string): Promise<void> {
	await writeText(join(store, "narrative", "FACTS.md"), "Fei owns his memory.\n");
	await writeText(join(store, "narrative", "CONTEXT.md"), "# CONTEXT\n\nFei builds Her as owned memory.\n");
	await writeText(join(store, "choice-model", "code-style.md"), "# Code Style\n\nPrefer small verified diffs.\n");
	await writeText(join(store, "topics", "active.md"), "# Current Work\n\nA6 prior assembler is active.\n");
	await writeText(join(store, "semantic", "task-note.md"), "# Task Note\n\nA6 task memory should be cited.\n");
	await writeText(
		join(store, "samantha", "taste", "room-over-dashboard.md"),
		"---\nprivacy: private\n---\n# Room Over Dashboard\n\nPrivate taste must not leak.\n",
	);
	await writeText(
		join(store, "samantha", "taste", "opted-in.md"),
		"---\nprior: true\ndiffers_from_fei_rule: true\n---\n# Her Seat\n\nSamantha wants quiet room language.\n\n## Difference From Fei Rule\n\nFei prefers direct dashboards here.\n",
	);
}

async function clearDefaultChoiceFiles(store: string): Promise<void> {
	for (const file of [
		"README.md",
		"writing-style.md",
		"design-taste.md",
		"communication-tone.md",
		"vibe-forge-dna.md",
	]) {
		await writeText(join(store, "choice-model", file), "");
	}
}

test("assemblePrior is deterministic, attributable, pure, and updates id when a source changes", async () => {
	const store = await tempStore();
	await writePriorFixture(store);
	const stateBefore = await readFile(join(store, ".her", "state.json"), "utf8");

	const first = await assemblePrior({ mode: "full", storeRoot: store, task: "A6 task" });
	const second = await assemblePrior({ mode: "full", storeRoot: store, task: "A6 task" });

	assert.equal(second.text, first.text);
	assert.equal(second.priorId, first.priorId);
	assert.equal(await readFile(join(store, ".her", "state.json"), "utf8"), stateBefore);
	assert.match(first.priorId, /^[a-f0-9]{12}$/);
	assert.deepEqual(
		first.blocks.map((block) => block.layer),
		["L1", "L2", "L3", "L3", "L3", "L3", "L3", "L3", "L4", "L5", "S"],
	);
	assert.match(first.text, /<!-- prior:L1 narrative\/FACTS\.md -->/);
	assert.match(first.text, /<!-- prior:L5 semantic\/task-note -->/);
	assert.match(first.text, /\[\[semantic\/task-note\]\]/);

	await writeText(join(store, "narrative", "FACTS.md"), "Fei owns his memory and audits it.\n");
	const changed = await assemblePrior({ mode: "full", storeRoot: store, task: "A6 task" });
	assert.notEqual(changed.priorId, first.priorId);
});

test("assemblePrior enforces budgets and trims L5 before L4 before L3", async () => {
	const store = await tempStore();
	await clearDefaultChoiceFiles(store);
	await writeText(join(store, "narrative", "FACTS.md"), "Facts stay.\n");
	await writeText(join(store, "narrative", "CONTEXT.md"), "Context stays.\n");
	await writeText(join(store, "choice-model", "code-style.md"), `# L3\n\n${"l3 ".repeat(160)}\n`);
	await writeText(join(store, "topics", "active.md"), `# L4\n\n${"l4 ".repeat(160)}\n`);
	await writeText(join(store, "semantic", "task-note.md"), `# L5\n\n${"l5 ".repeat(160)}\n`);

	const prior = await assemblePrior({ budget: 45, mode: "full", storeRoot: store, task: "l5" });

	assert.match(prior.text, /Facts stay/);
	assert.match(prior.text, /Context stays/);
	assert.match(prior.text, /# L3/);
	assert.doesNotMatch(prior.text, /# L4/);
	assert.doesNotMatch(prior.text, /# L5/);
	assert.ok(prior.blocks.reduce((sum, block) => sum + block.tokens, 0) <= 45);
});

test("assemblePrior only includes opt-in Samantha taste and accepts an empty S seat", async () => {
	const store = await tempStore();
	await writePriorFixture(store);

	const full = await assemblePrior({ mode: "full", storeRoot: store });
	assert.match(full.text, /Her Seat/);
	assert.match(full.text, /Samantha wants quiet room language/);
	assert.match(full.text, /Difference From Fei Rule/);
	assert.doesNotMatch(full.text, /Private taste must not leak/);

	const emptyStore = await tempStore();
	const empty = await assemblePrior({ mode: "full", storeRoot: emptyStore });
	const sBlock = empty.blocks.find((block) => block.layer === "S");
	assert.ok(sBlock);
	assert.equal(sBlock.tokens, 0);
});

test("assemblePrior supports off and her-only modes", async () => {
	const store = await tempStore();
	await writePriorFixture(store);

	const off = await assemblePrior({ mode: "off", storeRoot: store, task: "A6 task" });
	assert.deepEqual(off, { blocks: [], priorId: "off", text: "" });

	const herOnly = await assemblePrior({ mode: "her-only", storeRoot: store, task: "A6 task" });
	assert.deepEqual(
		herOnly.blocks.map((block) => block.layer),
		["S"],
	);
	assert.match(herOnly.text, /Her Seat/);
	assert.doesNotMatch(herOnly.text, /Fei owns his memory/);
});

test("CLI prints prior text and id", async () => {
	const store = await tempStore();
	await writePriorFixture(store);
	let stdout = "";
	let stderr = "";

	const code = await runHerCli(["prior", "--task", "A6 task", "--json"], { HER_MEMORY_DIR: store }, store, {
		stderr: {
			write(text: string) {
				stderr += text;
				return true;
			},
		} as NodeJS.WritableStream,
		stdout: {
			write(text: string) {
				stdout += text;
				return true;
			},
		} as NodeJS.WritableStream,
	});

	assert.equal(code, 0, stderr);
	const payload = JSON.parse(stdout) as { result: { priorId: string; text: string } };
	assert.match(payload.result.priorId, /^[a-f0-9]{12}$/);
	assert.match(payload.result.text, /<!-- prior:L1 narrative\/FACTS\.md -->/);
});

test("prior mode resolution supports env, action, session, and Samantha write guards", () => {
	assert.equal(resolvePriorMode({ env: { HER_PRIOR: "off" }, requestedMode: "full" }), "off");
	assert.equal(resolvePriorMode({ requestedMode: "her-only", sessionMode: "full" }), "her-only");
	assert.equal(resolvePriorMode({ sessionMode: "her-only" }), "her-only");
	assert.equal(resolvePriorMode({}), "full");
	assert.equal(priorModeForAction(["samantha/taste/private.md"], { requestedMode: "full" }), "her-only");
	assert.equal(priorModeForAction(["./samantha/journal/day.md"], { requestedMode: "full" }), "her-only");
	assert.equal(priorModeForAction(["narrative/CONTEXT.md"], { requestedMode: "full" }), "full");
	assert.equal(
		priorModeForAction(["samantha/taste/private.md"], { env: { HER_PRIOR: "off" }, requestedMode: "full" }),
		"off",
	);
});

test("recordPriorAudit appends prior ledger entries and fails loud", async () => {
	const store = await tempStore();
	const prior = await assemblePrior({ mode: "off", storeRoot: store });
	await recordPriorAudit(store, { action: "unit-test", prior, ts: "2026-07-03T00:00:00.000Z" });

	const audit = (await readText(join(store, "audit", "2026-07-03.jsonl"))) ?? "";
	const entry = JSON.parse(audit.trim()) as { action: string; priorId: string; mode: string; blocks: unknown[] };
	assert.deepEqual(entry, {
		action: "unit-test",
		blocks: [],
		mode: "off",
		priorId: "off",
		ts: "2026-07-03T00:00:00.000Z",
	});

	const blocked = await tempStore();
	await writeText(join(blocked, "audit"), "not a directory");
	await assert.rejects(
		recordPriorAudit(blocked, { action: "unit-test", prior, ts: "2026-07-03T00:00:00.000Z" }),
		/audit/,
	);
});

test("getContext keeps the default shape and adds prior only when requested", async () => {
	const store = await tempStore();
	await writePriorFixture(store);
	const memory = new Memory(store);

	const plain = await memory.getContext();
	assert.equal("prior" in plain, false);

	const withPrior = await memory.getContext({ prior: { action: "context-test", task: "A6 task" } });
	assert.equal(withPrior.prior?.priorId.length, 12);
	assert.match(withPrior.prior?.text ?? "", /A6 task memory should be cited/);
	const auditFile = (await readdir(join(store, "audit"))).find((name) => name.endsWith(".jsonl"));
	assert.ok(auditFile);
	const audit = (await readText(join(store, "audit", auditFile))) ?? "";
	assert.match(audit, /"action":"context-test"/);

	const herZone = await memory.getContext({
		prior: { action: "her-zone", mode: "full", writeTargets: ["samantha/wants/x.md"] },
	});
	assert.equal(herZone.prior?.blocks.map((block) => block.layer).join(","), "S");
	assert.doesNotMatch(herZone.prior?.text ?? "", /Fei owns his memory/);
});
