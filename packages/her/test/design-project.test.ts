import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerDesignProjectTools } from "../src/design-project/tools.ts";
import { governedTools } from "../src/extension.ts";
import {
	auditProjects,
	createProject,
	DESIGN_STAGES,
	getProject,
	listProjects,
	recordGateVerdict,
	setStage,
} from "../src/her-core/design-project.ts";

const EVIDENCE = "Fei: wireframe is enough to draft — annotation #a1";
const FINAL_EVIDENCE = "Fei: final is closed — annotation #f1";

async function tempDir(t: test.TestContext): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "her-design-project-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function advanceTo(
	dir: string,
	slug: string,
	target: (typeof DESIGN_STAGES)[number],
	opts?: { approveWireframe?: boolean; approveFinal?: boolean },
): Promise<void> {
	const approveWireframe = opts?.approveWireframe ?? true;
	const approveFinal = opts?.approveFinal ?? true;
	const current = await getProject(slug, dir);
	assert.ok(current);
	const from = DESIGN_STAGES.indexOf(current.stage);
	const to = DESIGN_STAGES.indexOf(target);
	assert.ok(from >= 0 && to >= 0 && to >= from);
	for (let i = from; i < to; i++) {
		const next = DESIGN_STAGES[i + 1];
		if (next === "draft" && approveWireframe) {
			await recordGateVerdict(slug, "wireframe", "approved", EVIDENCE, dir);
		}
		if (next === "code" && approveFinal) {
			await recordGateVerdict(slug, "final", "approved", FINAL_EVIDENCE, dir);
		}
		await setStage(slug, next, { note: `leave ${DESIGN_STAGES[i]}` }, dir);
	}
}

function harness(projectsDir: string): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignProjectTools(pi, { projectsDir });
	return tools;
}

async function run(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test("eight stages advance on the happy path from idea to code", async (t) => {
	const dir = await tempDir(t);
	const created = await createProject("landing-exam", "dynamic landing page", dir);
	assert.equal(created.stage, "idea");
	assert.deepEqual(
		[...DESIGN_STAGES],
		["idea", "research", "moodboard", "wireframe", "draft", "iterations", "final", "code"],
	);

	await advanceTo(dir, "landing-exam", "code");
	const done = await getProject("landing-exam", dir);
	assert.ok(done);
	assert.equal(done.stage, "code");
	assert.equal(done.gates.wireframe?.status, "approved");
	assert.equal(done.gates.final?.status, "approved");
	assert.ok((done.gates.moodboard?.status === "informed" || done.gates.moodboard?.status === "approved") ?? true);
	assert.equal(Object.keys(done.steps).length >= 7, true);

	const listed = await listProjects(dir);
	assert.equal(
		listed.some((row) => row.slug === "landing-exam" && row.stage === "code"),
		true,
	);
});

test("entering draft is blocked until the wireframe gate is approved, then allowed", async (t) => {
	const dir = await tempDir(t);
	await createProject("draft-gate", "need a wireframe first", dir);
	await advanceTo(dir, "draft-gate", "wireframe", { approveWireframe: false });

	await assert.rejects(() => setStage("draft-gate", "draft", {}, dir), /wireframe/i);

	const blocked = await getProject("draft-gate", dir);
	assert.equal(blocked?.stage, "wireframe");

	await recordGateVerdict("draft-gate", "wireframe", "approved", EVIDENCE, dir);
	const allowed = await setStage("draft-gate", "draft", { note: "wireframe signed" }, dir);
	assert.equal(allowed.stage, "draft");
});

test("entering code is blocked until the final gate is approved, then allowed", async (t) => {
	const dir = await tempDir(t);
	await createProject("final-gate", "the second hard gate holds too", dir);
	await advanceTo(dir, "final-gate", "final", { approveFinal: false });

	await assert.rejects(() => setStage("final-gate", "code", {}, dir), /final/i);

	const blocked = await getProject("final-gate", dir);
	assert.equal(blocked?.stage, "final");

	await recordGateVerdict("final-gate", "final", "approved", FINAL_EVIDENCE, dir);
	const allowed = await setStage("final-gate", "code", { note: "final signed" }, dir);
	assert.equal(allowed.stage, "code");
});

test("approved gate with empty or blank evidence is refused", async (t) => {
	const dir = await tempDir(t);
	await createProject("empty-evidence", "must quote Fei", dir);
	await advanceTo(dir, "empty-evidence", "wireframe", { approveWireframe: false });

	await assert.rejects(() => recordGateVerdict("empty-evidence", "wireframe", "approved", "", dir), /evidence/i);
	await assert.rejects(
		() => recordGateVerdict("empty-evidence", "wireframe", "approved", "   \n\t", dir),
		/evidence/i,
	);

	const after = await getProject("empty-evidence", dir);
	assert.notEqual(after?.gates.wireframe?.status, "approved");
});

test("audit flags on-disk approved-without-evidence as red, and does not flag evidenced approved", async (t) => {
	const dir = await tempDir(t);
	const now = new Date().toISOString();
	await writeFile(
		join(dir, "bare-approved.project.json"),
		`${JSON.stringify(
			{
				slug: "bare-approved",
				brief: "planted",
				stage: "draft",
				createdAt: now,
				updatedAt: now,
				steps: {},
				gates: { wireframe: { status: "approved", evidence: "  ", at: now } },
				iterations: [],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(
		join(dir, "evidenced.project.json"),
		`${JSON.stringify(
			{
				slug: "evidenced",
				brief: "planted ok",
				stage: "draft",
				createdAt: now,
				updatedAt: now,
				steps: {},
				gates: { wireframe: { status: "approved", evidence: EVIDENCE, at: now } },
				iterations: [],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const findings = await auditProjects(dir);
	const bare = findings.filter((row) => row.slug === "bare-approved");
	assert.ok(bare.some((row) => row.severity === "red" && /evidence/i.test(row.message)));
	assert.equal(
		findings.some((row) => row.slug === "evidenced" && /evidence/i.test(row.message)),
		false,
	);
});

test("at iterations, set_stage(iterations) with a note appends a round instead of refusing", async (t) => {
	const dir = await tempDir(t);
	await createProject("rounds", "landing exam", dir);
	await advanceTo(dir, "rounds", "iterations");
	const before = await getProject("rounds", dir);
	assert.ok(before);
	const rounds = before.iterations.length;
	const t0 = Date.now();

	const after = await setStage("rounds", "iterations", { note: "round 2: removed the twin brick" }, dir);
	assert.equal(after.stage, "iterations");
	assert.equal(after.iterations.length, rounds + 1);
	const last = after.iterations[after.iterations.length - 1];
	assert.ok(last);
	assert.equal(last.summary, "round 2: removed the twin brick");
	const stamped = Date.parse(last.at);
	assert.ok(stamped >= t0 - 1000 && stamped <= Date.now() + 1000, `at must be the tool's clock, got ${last.at}`);
	assert.equal(after.updatedAt, last.at);

	// Same stage without a note is still a refusal, at iterations and everywhere else.
	await assert.rejects(() => setStage("rounds", "iterations", undefined, dir), /already at stage/);
	await assert.rejects(() => setStage("rounds", "iterations", { note: "   " }, dir), /already at stage/);
	await createProject("still-idea", "planted", dir);
	await assert.rejects(() => setStage("still-idea", "idea", { note: "a note" }, dir), /already at stage/);

	// Through the tool: the reply is ok and carries the appended round.
	const tools = harness(dir);
	const viaTool = await run(tools.get("design_project_set_stage"), {
		slug: "rounds",
		stage: "iterations",
		note: "round 3: label snug to the brick",
	});
	assert.equal(viaTool.details.ok, true, viaTool.text);
	const manifest = viaTool.details.manifest as { iterations: Array<{ summary: string }> };
	assert.equal(manifest.iterations.length, rounds + 2);
	assert.equal(manifest.iterations[manifest.iterations.length - 1]?.summary, "round 3: label snug to the brick");
});

test("audit flags hand-edited iteration records (no summary) and timestamps in the future", async (t) => {
	const dir = await tempDir(t);
	const now = new Date().toISOString();
	const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
	const plant = (slug: string, body: Record<string, unknown>) =>
		writeFile(join(dir, `${slug}.project.json`), `${JSON.stringify(body, null, 2)}\n`, "utf8");
	await plant("hand-edited", {
		slug: "hand-edited",
		brief: "planted",
		stage: "iterations",
		createdAt: now,
		updatedAt: future,
		steps: { draft: { note: "written by hand", at: future } },
		gates: { wireframe: { status: "approved", evidence: EVIDENCE, at: now } },
		iterations: [{ at: future, note: "round written by hand with the wrong field name" }],
	});
	await plant("clean", {
		slug: "clean",
		brief: "planted ok",
		stage: "iterations",
		createdAt: now,
		updatedAt: now,
		steps: { draft: { note: "tool-written", at: now } },
		gates: { wireframe: { status: "approved", evidence: EVIDENCE, at: now } },
		iterations: [{ at: now, summary: "round 1" }],
	});

	const findings = await auditProjects(dir);
	const bad = findings.filter((row) => row.slug === "hand-edited");
	assert.ok(
		bad.some((row) => row.severity === "red" && /summary/i.test(row.message)),
		`expected a missing-summary finding, got ${JSON.stringify(bad)}`,
	);
	assert.ok(
		bad.some((row) => row.severity === "red" && /future/i.test(row.message)),
		`expected a future-timestamp finding, got ${JSON.stringify(bad)}`,
	);
	assert.equal(
		findings.some((row) => row.slug === "clean"),
		false,
		`clean manifest must not be flagged: ${JSON.stringify(findings)}`,
	);
});

test("slug path traversal and non-slug names are refused", async (t) => {
	const dir = await tempDir(t);
	const bad = ["../escape", "..\\escape", "foo/bar", "foo\\bar", "Foo", "", ".", "..", "foo bar", "/abs", "a_b"];
	for (const slug of bad) {
		await assert.rejects(() => createProject(slug, "brief", dir), /slug/i);
	}
	const ok = await createProject("ok-slug-1", "brief", dir);
	assert.equal(ok.slug, "ok-slug-1");
	const raw = await readFile(join(dir, "ok-slug-1.project.json"), "utf8");
	assert.equal(JSON.parse(raw).slug, "ok-slug-1");
});

test("concurrent writes to the same and different slugs do not truncate JSON", async (t) => {
	const dir = await tempDir(t);
	await Promise.all([createProject("alpha", "brief-a", dir), createProject("beta", "brief-b", dir)]);
	assert.equal(JSON.parse(await readFile(join(dir, "alpha.project.json"), "utf8")).slug, "alpha");
	assert.equal(JSON.parse(await readFile(join(dir, "beta.project.json"), "utf8")).slug, "beta");

	await createProject("same", "shared", dir);
	const writes = await Promise.allSettled(
		Array.from({ length: 8 }, (_, i) => setStage("same", "research", { note: `writer-${i}` }, dir)),
	);
	const raw = await readFile(join(dir, "same.project.json"), "utf8");
	const parsed = JSON.parse(raw) as { slug: string; stage: string; steps?: Record<string, unknown> };
	assert.equal(parsed.slug, "same");
	assert.equal(typeof parsed.stage, "string");
	assert.ok(writes.some((row) => row.status === "fulfilled"));
});

test("six design project tools are registered, describe consequences, and enforce the two hard rules", async (t) => {
	const dir = await tempDir(t);
	const tools = harness(dir);
	const names = [
		"design_project_create",
		"design_project_get",
		"design_project_list",
		"design_project_set_stage",
		"design_project_gate",
		"design_project_audit",
	] as const;
	for (const name of names) {
		assert.equal(tools.has(name), true, name);
		assert.equal(governedTools[name]?.destructive, false);
	}

	const setStageTool = tools.get("design_project_set_stage");
	const gateTool = tools.get("design_project_gate");
	assert.match(setStageTool?.description ?? "", /draft/i);
	assert.match(setStageTool?.description ?? "", /wireframe/i);
	assert.match(gateTool?.description ?? "", /evidence/i);

	const created = await run(tools.get("design_project_create"), { slug: "tool-card", brief: "exam" });
	assert.equal(created.details.ok, true);

	await run(tools.get("design_project_set_stage"), { slug: "tool-card", stage: "research" });
	await run(tools.get("design_project_set_stage"), { slug: "tool-card", stage: "moodboard" });
	await run(tools.get("design_project_set_stage"), { slug: "tool-card", stage: "wireframe" });

	const blocked = await run(tools.get("design_project_set_stage"), { slug: "tool-card", stage: "draft" });
	assert.equal(blocked.details.ok, false);
	assert.match(blocked.text, /wireframe/i);

	const empty = await run(tools.get("design_project_gate"), {
		slug: "tool-card",
		gate: "wireframe",
		status: "approved",
		evidence: "  ",
	});
	assert.equal(empty.details.ok, false);
	assert.match(empty.text, /evidence/i);

	const approved = await run(tools.get("design_project_gate"), {
		slug: "tool-card",
		gate: "wireframe",
		status: "approved",
		evidence: EVIDENCE,
	});
	assert.equal(approved.details.ok, true);

	const allowed = await run(tools.get("design_project_set_stage"), { slug: "tool-card", stage: "draft" });
	assert.equal(allowed.details.ok, true);

	const listed = await run(tools.get("design_project_list"), {});
	assert.equal(listed.details.ok, true);
	const got = await run(tools.get("design_project_get"), { slug: "tool-card" });
	assert.equal(got.details.ok, true);
	const audited = await run(tools.get("design_project_audit"), {});
	assert.equal(audited.details.ok, true);
});
