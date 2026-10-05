import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { type GrowthHostPlan, HerGrowthHost } from "../src/growth-experiment/host.ts";
import { GrowthJournal } from "../src/growth-experiment/journal.ts";
import { runGrowthPilot } from "../src/growth-experiment/pilot.ts";
import { auditGrowthPilot, validatePilotAuthorization } from "../src/growth-experiment/pilot-authorization.ts";
import { startDrain } from "../src/her-core/drain.ts";
import { sha256 } from "../src/her-core/improvement-plan.ts";
import { fixture } from "./fixtures/growth-task-host.ts";

// Host/usage/authorization fixtures are engineering evidence only.
function pilotPlan(plan: GrowthHostPlan) {
	const task = (id: string) => ({
		id,
		description: id,
		environment: "text",
		input: { marker: id },
		expected: { ok: true },
	});
	plan.tasks = [task("T1"), task("T2"), task("T3"), task("T4"), task("development")];
	plan.pilot = { finalTaskIds: ["T1", "T2", "T3", "T4"], developmentTaskId: "development", thoughts: 12, probes: 2 };
}
test("new pilot checks unknown spend in every other inquiry before another request", async (t) => {
	const { host, root, model } = await fixture(t, "use", undefined, (plan) => {
		const task = (id: string) => ({
			id,
			description: id,
			environment: "text",
			input: { marker: id },
			expected: { ok: true },
		});
		plan.tasks = [task("T1"), task("T2"), task("T3"), task("T4"), task("development")];
		plan.pilot = {
			finalTaskIds: ["T1", "T2", "T3", "T4"],
			developmentTaskId: "development",
			thoughts: 12,
			probes: 2,
		};
	});
	await new GrowthJournal(root, "foreign-unsettled").append("model-reserve", { runId: "other-request" });
	await assert.rejects(host.assertRunning(), /unreconciled|outside.*decision/);
	assert.equal(model.calls.length, 0);
});

test("frozen authorization preserves one historical unknown and known subtotals, never settles it", async (t) => {
	const { host, root, model } = await fixture(t, "use", undefined, pilotPlan);
	const old = new GrowthJournal(root, "historical-inquiry");
	const original = await readFile(old.path);
	const snapshot = await auditGrowthPilot(root, host.plan);
	assert.equal(snapshot.knownTokens, 60);
	assert.equal(snapshot.totalTokens, "unknown");
	assert.equal(snapshot.totalUsd, "unknown");
	assert.equal(snapshot.historicalUnknown.runId, "accepted-old");
	assert.ok(!(await old.read()).some((r) => r.kind === "model-result" && r.data.runId === "accepted-old"));
	const reopened = await HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model);
	assert.equal((await reopened.journal.read()).filter((r) => r.kind === "human-pilot-authorization").length, 1);
	assert.deepEqual(await readFile(old.path), original);
});
for (const block of [
	"no-owner",
	"budget",
	"output",
	"scope",
	"root",
	"window",
	"probe",
	"decision",
	"approval-change",
	"input-change",
	"endpoint",
] as const) {
	test(`owner pilot ${block} cannot authorize another request`, async (t) => {
		if (block === "no-owner") {
			await assert.rejects(fixture(t, "use", undefined, pilotPlan, false, false), /bound owner.*authorization/);
			return;
		}
		const { host, root, model } = await fixture(t, "use", undefined, pilotPlan);
		const plan = { ...structuredClone(host.plan) };
		if (block === "budget") plan.budget.requests = 33;
		if (block === "output") plan.model.maxOutputTokens = 8193;
		if (block === "scope") (plan.pilotAuthorization as unknown as { scope: string }).scope = "provider-response-only";
		if (block === "root") {
			await mkdir(join(root, "other-root"));
			plan.pilotAuthorization!.memoryRoot = join(root, "other-root");
		}
		if (block === "window")
			plan.pilotAuthorization!.expiresAt = new Date(Date.parse(plan.expiresAt) + 60000).toISOString();
		if (block === "probe")
			plan.pilotAuthorization!.modelProbe = {
				inquiryId: "historical-inquiry",
				receiptDigest: sha256("different receipt"),
			};
		if (block === "decision")
			plan.pilotAuthorization!.historicalUnknown.decisionDigest = sha256("different decision");
		if (block === "approval-change") await writeFile(join(root, plan.pilotAuthorization!.approval.file), "changed");
		if (block === "input-change") await writeFile(join(root, plan.pilot!.experience!.file), "[]");
		if (block === "endpoint")
			await writeFile(
				join(root, ".her/config.yaml"),
				"llm:\n  base_url: https://api.deepseek.com/different-path\n  model_fast: deepseek-v4-flash\n",
			);
		await assert.rejects(auditGrowthPilot(root, plan));
		assert.equal(model.calls.length, 0);
	});
}
for (const block of [
	"foreign-unknown",
	"foreign-corrupt",
	"fake-settlement",
	"concurrent-spend",
	"owner-reused",
	"new-known-failure",
	"new-unknown",
	"stop",
] as const) {
	test(`full root ${block} blocks new spend and preserves the reservation`, async (t) => {
		const { host, root, model } = await fixture(t, "use", undefined, pilotPlan);
		const other = new GrowthJournal(root, "other-inquiry");
		if (block === "foreign-unknown" || block === "concurrent-spend") {
			await other.append("model-reserve", { runId: "foreign-request" });
			if (block === "concurrent-spend")
				await other.append("model-result", { runId: "foreign-request", tokens: 30, usd: 0.000018 });
		}
		if (block === "foreign-corrupt") {
			await other.append("note", { note: "fixture" });
			await writeFile(other.path, `${await readFile(other.path, "utf8")}incomplete`);
		}
		if (block === "fake-settlement")
			await new GrowthJournal(root, "historical-inquiry").append("model-result", {
				runId: "accepted-old",
				tokens: 0,
				usd: 0,
			});
		if (block === "owner-reused")
			await other.append("human-pilot-authorization", {
				approvalSourceReference: "offline-engineering-owner-fixture-only",
			});
		if (block === "new-known-failure" || block === "new-unknown") {
			await host.journal.append("model-reserve", { runId: "new-request" });
			if (block === "new-known-failure")
				await host.journal.append("model-result", {
					runId: "new-request",
					tokens: 30,
					usd: 0.000018,
					error: "fixture failure",
				});
			else await host.journal.append("model-unknown", { runId: "new-request" });
		}
		if (block === "stop") await startDrain({ memoryDir: root, reason: "fixture STOP" });
		await assert.rejects(host.assertRunning());
		await assert.rejects(host.reason({ stage: "discover", instruction: "fixture", data: {} }));
		assert.equal(model.calls.length, 0);
	});
}
test("new pilot cannot reuse one-shot probe, skip continuous reservation", async (t) => {
	const { host, model } = await fixture(t, "use", undefined, pilotPlan);
	await assert.rejects(host.probeModel(), /connectivity probe/);
	await assert.rejects(host.reason({ stage: "discover", instruction: "fixture", data: {} }), /runner reservation/);
	assert.equal(model.calls.length, 0);
});
test("owner statement cannot omit risk or claim an old probe scope even with a matching file hash", async (t) => {
	const { host, root } = await fixture(t, "use", undefined, pilotPlan);
	const plan = { ...structuredClone(host.plan) };
	const path = join(root, plan.pilotAuthorization!.approval.file);
	const approval = JSON.parse(await readFile(path, "utf8"));
	approval.scope = "provider-response-only";
	const text = JSON.stringify(approval);
	await writeFile(path, text);
	plan.pilotAuthorization!.approval.sha256 = sha256(text);
	await assert.rejects(validatePilotAuthorization(root, plan), /new direct owner approval/);
});

test("initial learning state cannot substitute altered teacher text for the frozen raw experience", async (t) => {
	const { host, model } = await fixture(t, "use", undefined, pilotPlan, true);
	const state = (await host.journal.state())!;
	await host.journal.append("state", {
		state: { ...state, experiences: [{ ...state.experiences[0], expectation: "injected prewritten root cause" }] },
	});
	await assert.rejects(runGrowthPilot(host), /differs from approved raw/);
	assert.equal(model.calls.length, 0);
});
test("frozen T0/T1 cannot be reset across host restart and timezone is mandatory", async (t) => {
	const { host, root, model } = await fixture(t, "use", undefined, pilotPlan);
	const plan = { ...structuredClone(host.plan) };
	plan.pilotAuthorization!.startsAt = new Date(Date.parse(plan.pilotAuthorization!.startsAt) + 60000).toISOString();
	plan.pilotAuthorization!.expiresAt = new Date(Date.parse(plan.expiresAt) + 60000).toISOString();
	plan.expiresAt = plan.pilotAuthorization!.expiresAt;
	await writeFile(join(root, "evals/plan.json"), JSON.stringify(plan));
	await assert.rejects(
		HerGrowthHost.open(root, "evals/plan.json", join(root, "candidate"), model),
		/changed after freeze/,
	);
	plan.pilotAuthorization!.startsAt = plan.pilotAuthorization!.startsAt.replace("Z", "");
	await assert.rejects(validatePilotAuthorization(root, plan), /explicit timezone/);
	assert.equal(model.calls.length, 0);
});

test("formal Her pilot CLI consumes one strict loopback request, retains denominator and cannot replay", async (t) => {
	let requests = 0;
	let unknown = false;
	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		requests++;
		assert.equal(body.max_tokens, 128);
		assert.ok(!body.messages[0].content.includes('"expected"'));
		res.setHeader("Content-Type", "application/json");
		res.end(
			JSON.stringify({
				model: "deepseek-v4-flash",
				id: `local-pilot-${requests}`,
				choices: [
					{ finish_reason: "stop", message: { content: '{"decision":"defer","reason":"fixture no useful gap"}' } },
				],
				...(unknown ? {} : { usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }),
			}),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	for (const missingUsage of [false, true]) {
		unknown = missingUsage;
		const { root, host } = await fixture(t, "use", `127.0.0.1:${address.port}`, pilotPlan, true, true, false);
		const command = promisify(execFile);
		const args = ["--import", "tsx", "packages/her/src/cli.ts", "growth", "pilot", root, "evals/plan.json"];
		const options = {
			cwd: process.cwd(),
			env: { ...process.env, TEST_TASK_KEY: "loopback-fixture-only" },
			timeout: 20000,
		};
		const before = requests;
		let output: string;
		if (missingUsage) {
			output = "";
			await assert.rejects(command(process.execPath, args, options), (error: unknown) => {
				const result = error as Error & { code: number; stdout: string };
				assert.equal(result.code, 1);
				output = result.stdout;
				return true;
			});
		} else output = (await command(process.execPath, args, options)).stdout;
		const report = JSON.parse(output);
		assert.equal(report.status, missingUsage ? "INCOMPLETE" : "NO-METHOD");
		assert.equal(report.rows.length, 8);
		assert.ok(
			report.rows.every((r: { usage: unknown; status: string }) => r.status === "missing" && r.usage === null),
		);
		assert.equal(report.usage.requests, 1);
		assert.equal(report.usage.tokens, missingUsage ? null : 30);
		assert.equal(requests - before, 1);
		assert.equal((await host.journal.state())!.limits.probes, 2);
		await assert.rejects(command(process.execPath, args, options));
		assert.equal(requests - before, 1);
		const rows = await host.journal.read();
		assert.equal(rows.filter((r) => r.kind === "pilot-stop").length, 1);
		assert.equal(rows.filter((r) => r.kind === "model-reserve").length, 1);
		await assert.rejects(
			command(
				process.execPath,
				["--import", "tsx", "packages/her/src/cli.ts", "growth", "probe-model", root, "evals/plan.json"],
				options,
			),
		);
		assert.equal(requests - before, 1);
	}
});
