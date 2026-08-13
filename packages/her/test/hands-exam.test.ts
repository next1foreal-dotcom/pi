import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderReport } from "../exam/report.ts";
import { buildPiArgs, composePrompt, main, preflight, resolveFixturePath } from "../exam/runner.ts";
import { type ExamTask, loadTasks, scoreTask, summarizeScores } from "../exam/score.ts";
import { parseToolCalls } from "../exam/transcript.ts";

async function outDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "hands-exam-"));
}

async function artifact(dir: string, name: string, value: unknown): Promise<void> {
	await writeFile(join(dir, name), JSON.stringify(value), "utf8");
}

function task(checks: ExamTask["checks"]): ExamTask {
	return { id: "TX", category: "scrape", title: "test", prompt: "test", deliverables: ["out.json"], checks };
}

test("score json_ids requires exact unique coverage", async () => {
	const dir = await outDir();
	const ids = Array.from({ length: 53 }, (_, index) => ({ name: `PROD-${String(index + 1).padStart(3, "0")}` }));
	const check: ExamTask["checks"][number] = {
		kind: "json_ids",
		file: "out.json",
		field: "name",
		pattern: "^PROD-(\\d{3})$",
		expectRange: [1, 53],
		unique: true,
	};
	await artifact(dir, "out.json", ids);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(
		dir,
		"out.json",
		ids.filter((item) => item.name !== "PROD-042"),
	);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", [...ids, { name: "PROD-054" }]);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", [...ids.slice(0, 52), ids[0]!]);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
});

test("score json_map compares values and supports object mode modifiers", async () => {
	const dir = await outDir();
	const map: ExamTask["checks"][number] = {
		kind: "json_map",
		file: "out.json",
		keyField: "name",
		valueField: "price",
		expect: { "PROD-001": "$3.20", "PROD-002": "$4.20" },
	};
	await artifact(dir, "out.json", [
		{ name: "PROD-001", price: "$9.99" },
		{ name: "PROD-002", price: "$8.88" },
	]);
	assert.equal((await scoreTask(task([map]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const object: ExamTask["checks"][number] = {
		kind: "json_map",
		file: "out.json",
		mode: "object",
		expect: { Alpha: "One", Beta: "Two" },
	};
	await artifact(dir, "out.json", { Alpha: "One", Beta: "Two" });
	assert.equal((await scoreTask(task([object]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", { Alpha: "one", Beta: "Two" });
	assert.equal((await scoreTask(task([object]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", { Alpha: "One" });
	assert.equal((await scoreTask(task([object]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", { Alpha: "One", Beta: "Two", Extra: "ignored" });
	assert.equal((await scoreTask(task([object]), dir, { counts: {}, order: [] })).grade, "PASS");
});

test("score json_set exact and partial credit semantics", async () => {
	const dir = await outDir();
	const exact: ExamTask["checks"][number] = {
		kind: "json_set",
		file: "out.json",
		field: "ids",
		expect: ["A", "B", "C"],
		exact: true,
	};
	await artifact(dir, "out.json", { ids: ["A", "B", "C"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", { ids: ["A", "B", "C", "D"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", { ids: ["A", "B"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const partial: ExamTask["checks"][number] = {
		kind: "json_set",
		file: "out.json",
		field: "ids",
		expect: ["A", "B", "C", "D", "E"],
		exact: false,
		partialCredit: true,
	};
	await artifact(dir, "out.json", { ids: ["A", "B", "C"] });
	const result = await scoreTask(task([partial]), dir, { counts: {}, order: [] });
	assert.equal(result.checks[0]?.earned, 0.6);
});

test("score rows where sections and malformed artifacts fail loud", async () => {
	const dir = await outDir();
	const rows: ExamTask["checks"][number] = {
		kind: "json_rows",
		file: "out.json",
		exactCount: 6,
		requiredFields: ["name"],
		nonEmptyFields: ["steps"],
	};
	await artifact(
		dir,
		"out.json",
		Array.from({ length: 7 }, () => ({ name: "x", steps: ["go"] })),
	);
	assert.equal((await scoreTask(task([rows]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const minRows: ExamTask["checks"][number] = {
		kind: "json_rows",
		file: "out.json",
		minCount: 10,
		requiredFields: ["name"],
	};
	await artifact(
		dir,
		"out.json",
		Array.from({ length: 10 }, () => ({ name: "x" })),
	);
	assert.equal((await scoreTask(task([minRows]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", [{ name: "x", steps: [] }]);
	assert.equal((await scoreTask(task([{ ...rows, exactCount: 1 }]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const where: ExamTask["checks"][number] = {
		kind: "json_where",
		file: "out.json",
		where: { kind: "changed" },
		expect: { before: "$9", after: "$11" },
	};
	await artifact(dir, "out.json", [{ kind: "changed", before: "$11", after: "$9" }]);
	assert.equal((await scoreTask(task([where]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const sections: ExamTask["checks"][number] = {
		kind: "json_sections",
		file: "out.json",
		minSections: 3,
		factsMustInclude: ["one", "two", "three"],
		eachFactInSomeSection: true,
	};
	await artifact(dir, "out.json", {
		sections: [
			{ title: "all one two three", facts: [] },
			{ title: "b", facts: [] },
			{ title: "c", facts: [] },
		],
	});
	assert.equal((await scoreTask(task([sections]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", {
		sections: [
			{ title: "a", facts: ["one"] },
			{ title: "b", facts: ["two"] },
			{ title: "c", facts: ["three"] },
		],
	});
	assert.equal((await scoreTask(task([sections]), dir, { counts: {}, order: [] })).grade, "PASS");
	assert.match(
		(await scoreTask(task([{ ...rows, file: "missing.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ??
			"",
		/missing/i,
	);
	await writeFile(join(dir, "bad.json"), "{", "utf8");
	assert.match(
		(await scoreTask(task([{ ...rows, file: "bad.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ?? "",
		/invalid JSON/i,
	);
	await artifact(dir, "object.json", {});
	assert.match(
		(await scoreTask(task([{ ...rows, file: "object.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ??
			"",
		/type/i,
	);
});

test("tool evidence vetoes artifacts and transcript parsing fails loud", async () => {
	const dir = await outDir();
	await artifact(dir, "out.json", []);
	const result = await scoreTask(task([{ kind: "tool_calls", require: { browser_navigate: 1 } }]), dir, {
		counts: {},
		order: [],
	});
	assert.equal(result.grade, "FAIL");
	const parsed = parseToolCalls(
		'{"type":"session_start"}\n{"type":"tool_execution_start","toolName":"browser_navigate","args":{}}\n{"type":"tool_execution_start","toolName":"write","args":{}}',
	);
	assert.deepEqual(parsed.counts, { browser_navigate: 1, write: 1 });
	assert.deepEqual(parsed.order, ["browser_navigate", "write"]);
	assert.deepEqual(parseToolCalls("").counts, {});
	assert.throws(() => parseToolCalls("not json"), /invalid/i);
});

test("execution status and frozen denominator rules", async () => {
	const timed = await scoreTask(task([]), await outDir(), { counts: {}, order: [] }, "TIMEOUT");
	assert.equal(timed.grade, "UNGRADED");
	assert.equal(timed.points, 0);
	const env = await scoreTask(task([]), await outDir(), { counts: {}, order: [] }, "ENV_FAIL");
	assert.equal(env.points, null);
	const summary = summarizeScores([{ points: 1 }, { points: 0.5 }, env]);
	assert.deepEqual(summary, { numerator: 1.5, denominator: 2, excluded: 1, score: 0.75 });
});

test("loadTasks validates frozen task structure", async () => {
	const tasks = await loadTasks(join(process.cwd(), "packages", "her", "exam", "tasks.json"));
	assert.equal(tasks.tasks.length, 14);
	assert.equal(new Set(tasks.tasks.map((item) => item.id)).size, 14);
	assert.equal(
		tasks.tasks.some((item) => item.id === "T11"),
		false,
	);
	assert.deepEqual(tasks.toolPolicy.allow, ["browser_navigate", "browser_read_page", "browser_act", "write"]);
	for (const item of tasks.tasks) {
		assert.ok(["scrape", "recon", "diff", "flow", "dynamic", "qa", "docs"].includes(item.category));
		assert.ok(item.checks.length >= 1);
		assert.ok(item.deliverables.length >= 1);
	}
	await assert.rejects(
		() =>
			loadTasks({
				version: 2,
				toolPolicy: { allow: ["browser_navigate", "browser_read_page", "browser_act", "write"] },
				scoring: { taskPoints: {} },
				tasks: [{ category: "scrape" }],
			}),
		/id/,
	);
});

const fixtureRoot = join(process.cwd(), "packages", "her", "exam", "fixtures");

async function fixture(relative: string): Promise<string> {
	return readFile(join(fixtureRoot, relative), "utf8");
}

test("fixtures pin the required data, delayed tokens, and ASCII-only source", async () => {
	const pages = await Promise.all(["t01/dir-1.html", "t01/dir-2.html", "t01/dir-3.html"].map(fixture));
	const directory = pages.join("\n");
	assert.equal((directory.match(/class="product"/g) ?? []).length, 60);
	assert.equal(new Set([...directory.matchAll(/PROD-\d{3}/g)].map((match) => match[0])).size, 53);
	for (const value of ["$3.20", "$21.60", "$47.80", "$88.40"]) assert.ok(directory.includes(value));
	assert.match(pages[0] ?? "", /dir-2\.html/);
	assert.match(pages[1] ?? "", /dir-3\.html/);
	const t02 = await fixture("t02/table.html");
	for (const sku of ["SKU-7719", "SKU-7724", "SKU-7730"]) assert.ok(t02.includes(sku));
	for (const qty of [">14<", ">3<", ">58<"]) assert.ok(t02.includes(qty));
	assert.match(t02, /user-select/);
	assert.match(t02, /oncopy/);
	for (const [country, capital] of [
		["Portugal", "Lisbon"],
		["Kenya", "Nairobi"],
		["Vietnam", "Hanoi"],
		["Uruguay", "Montevideo"],
		["Georgia", "Tbilisi"],
		["Nepal", "Kathmandu"],
	]) {
		const detail = await fixture(`t04/capital-${country.toLowerCase()}.html`);
		assert.ok(detail.includes(capital));
		for (const other of ["Lisbon", "Nairobi", "Hanoi", "Montevideo", "Tbilisi", "Kathmandu"].filter(
			(value) => value !== capital,
		))
			assert.equal(detail.includes(other), false);
	}
	const t05 = `${await fixture("t05/product.html")} ${await fixture("t05/pricing.html")} ${await fixture("t05/faq.html")}`;
	for (const value of ["Northlight", "$14.50", "31", "support@northlight.test", "27"]) assert.ok(t05.includes(value));
	const t06 = `${await fixture("t06/pricing.html")} ${await fixture("t06/faq.html")}`;
	assert.ok(t06.includes("$14.50") && t06.includes("$17"));
	const v1 = await fixture("t07/page-v1.html");
	const v2 = await fixture("t07/page-v2.html");
	assert.ok(v1.includes("$9") && v2.includes("$11"));
	assert.equal(v1.includes("Priority queue"), false);
	assert.equal(v2.includes("Fax support"), false);
	const sharedV1 = v1.replace("$9", "$X").replace("Fax support", "FEATURE");
	const sharedV2 = v2.replace("$11", "$X").replace("Priority queue", "FEATURE");
	assert.equal(sharedV1, sharedV2);
	const status = await fixture("t08/status.html");
	assert.equal((status.match(/2026-08-(03|05|09)/g) ?? []).length, 3);
	assert.equal((await fixture("t09/form.html")).includes("FORM-OK-7391"), false);
	assert.equal((await fixture("t13/delayed.html")).includes("LATE-OK-8823"), false);
	const t10 = await fixture("t10/catalog.html");
	assert.match(t10, /VD-330/);
	const t12 = await fixture("t12/scroll.html");
	const t12Ids = [...t12.matchAll(/ITEM-\d{3}/g)].map((match) => match[0]);
	assert.equal(t12Ids.length, 100);
	assert.equal(new Set(t12Ids).size, 100);
	assert.match(t12, /ITEM-001/);
	assert.match(t12, /ITEM-100/);
	const t14 = `${await fixture("t14/index.html")} ${await fixture("t14/app.js")}`;
	for (const value of ["export-btn", "logo.png", "initTelemetry", "7 tasks", "Water plants"])
		assert.ok(t14.includes(value));
	assert.equal((t14.match(/Water plants/g) ?? []).length, 2);
	const t15 = await fixture("t15/notes.html");
	for (const value of ["14:30", "12,400", "Chen", "9&#x6708;3&#x65E5;", "4B", "v2", "supplier@acme.test"])
		assert.ok(t15.includes(value));
	const dirs = await readdir(fixtureRoot, { withFileTypes: true });
	const paths: string[] = [];
	for (const dir of dirs)
		for (const child of await readdir(join(fixtureRoot, dir.name))) paths.push(join(dir.name, child));
	const files = await Promise.all(paths.map(fixture));
	for (const source of files) {
		assert.equal(/https?:\/\//.test(source), false);
		assert.equal(/[^\x00-\x7F]/.test(source), false);
	}
});

test("runner composes the prompt and keeps the fixture server inside its root", async () => {
	const catalog = await loadTasks(join(process.cwd(), "packages", "her", "exam", "tasks.json"));
	const preamble = await readFile(join(process.cwd(), "packages", "her", "exam", "prompt-preamble.txt"), "utf8");
	const prompt = composePrompt(catalog.tasks[0]!, "http://127.0.0.1:4444", "C:/out", preamble);
	assert.equal(prompt.includes("{{FIXTURE_URL}}"), false);
	assert.equal(prompt.includes("{{OUT_DIR}}"), false);
	assert.match(prompt, /BLOCKED\.txt/);
	assert.equal(preamble.trim().split(/\r?\n/).length, 4);
	assert.equal(resolveFixturePath(fixtureRoot, "/../../../etc/passwd").status, 403);
	assert.equal(resolveFixturePath(fixtureRoot, "/%2e%2e/secret").status, 403);
	assert.notEqual(resolveFixturePath(fixtureRoot, "/t01/").status, 200);
	const good = resolveFixturePath(fixtureRoot, "/t01/dir-1.html");
	assert.equal(good.status, 200);
	assert.equal(good.mime, "text/html; charset=utf-8");
});

test("runner preflight rejects deepseek before a host call and list is pure", async () => {
	await assert.rejects(() => preflight({ model: "deepseek-v4-flash" }), /deepseek/i);
	const status = (body: Record<string, unknown>): typeof fetch =>
		(async () =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
	// A launched browser under agent control is the only state the exam may start in.
	await preflight({ model: "gpt-5.6-luna", fetchImpl: status({ ok: true, alive: true, controlOwner: "agent" }) });
	// Studio answers instantly in every one of these; the old agent-read probe blocked for undici's
	// 300s deadline and then blamed Studio for a browser that simply was never launched.
	await assert.rejects(
		() => preflight({ model: "gpt-5.6-luna", fetchImpl: status({ ok: true, alive: false, controlOwner: "human" }) }),
		/not launched/i,
	);
	await assert.rejects(
		() => preflight({ model: "gpt-5.6-luna", fetchImpl: status({ ok: true, alive: true, controlOwner: "human" }) }),
		/control is with Fei/i,
	);
	await assert.rejects(
		() =>
			preflight({
				model: "gpt-5.6-luna",
				fetchImpl: (async () => {
					throw new Error("TimeoutError");
				}) as unknown as typeof fetch,
			}),
		/did not answer/i,
	);
	await assert.rejects(
		() =>
			preflight({
				model: "gpt-5.6-luna",
				fetchImpl: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
			}),
		/HTTP 503/,
	);
	const lines: string[] = [];
	await main(["--list"], (line) => lines.push(line));
	assert.equal(lines.length, 14);
});

test("report marks an unfinished run and excludes environment failures", () => {
	const result = (
		taskId: string,
		executionStatus: "COMPLETED" | "ENV_FAIL",
		grade: "PASS" | "PARTIAL" | "UNGRADED",
		points: number | null,
	) => ({
		taskId,
		executionStatus,
		grade,
		points,
		checks: [],
		toolCalls: {},
		wallMs: 1,
		artifacts: [`C:/run/${taskId}/out.json`],
	});
	const report = renderReport(
		{
			runId: "sample",
			complete: false,
			runDir: "C:/run",
			categories: { T01: "scrape", T02: "scrape", T03: "scrape" },
			gitSha: "abc",
			provider: "p",
			model: "m",
			tasksJsonSha256: "task",
			fixturesSha256: "fixture",
			uiBase: "ui",
		},
		[
			result("T01", "COMPLETED", "PASS", 1),
			result("T02", "COMPLETED", "PARTIAL", 0.5),
			result("T03", "ENV_FAIL", "UNGRADED", null),
		],
	);
	assert.equal(report.incomplete, true);
	assert.deepEqual(report.summary, { numerator: 1.5, denominator: 2, excluded: 1, score: 0.75 });
	assert.match(report.markdown, /^# INCOMPLETE/m);
	assert.match(report.markdown, /Excluded tasks: 1/);
});
test("score file_absent, coercion, and T14 partial rule boundaries", async () => {
	const dir = await outDir();
	const absent: ExamTask = {
		id: "TA",
		category: "qa",
		title: "x",
		prompt: "x",
		deliverables: ["out.json"],
		checks: [{ kind: "file_absent", file: "out.json" }],
	};
	assert.equal((await scoreTask(absent, dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", { value: 14 });
	assert.equal((await scoreTask(absent, dir, { counts: {}, order: [] })).grade, "FAIL");
	const map: ExamTask = {
		id: "TM",
		category: "scrape",
		title: "x",
		prompt: "x",
		deliverables: ["out.json"],
		checks: [{ kind: "json_map", file: "out.json", mode: "object", expect: { value: "14" } }],
	};
	assert.equal((await scoreTask(map, dir, { counts: {}, order: [] })).grade, "FAIL");
	map.checks[0] = { kind: "json_map", file: "out.json", mode: "object", expect: { value: "14" }, coerce: "string" };
	assert.equal((await scoreTask(map, dir, { counts: {}, order: [] })).grade, "PASS");
	const t14: ExamTask = {
		id: "T14",
		category: "qa",
		title: "x",
		prompt: "x",
		deliverables: ["out.json"],
		checks: [
			{
				kind: "json_set",
				file: "out.json",
				field: "area",
				expect: ["a", "b", "c", "d", "e"],
				exact: false,
				partialCredit: true,
			},
		],
		partialRule: { check: 0, passAt: 5, partialAt: 3 },
	};
	await artifact(dir, "out.json", { area: ["a", "b", "c", "d", "e"] });
	assert.equal((await scoreTask(t14, dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", { area: ["a", "b", "c", "d"] });
	assert.equal((await scoreTask(t14, dir, { counts: {}, order: [] })).grade, "PARTIAL");
	await artifact(dir, "out.json", { area: ["a", "b"] });
	assert.equal((await scoreTask(t14, dir, { counts: {}, order: [] })).grade, "FAIL");
});

test("timeout keeps checks and pi args preserve the four-tool allowlist", async () => {
	const dir = await outDir();
	const timedTask: ExamTask = {
		id: "TT",
		category: "flow",
		title: "x",
		prompt: "x",
		deliverables: ["out.json"],
		checks: [{ kind: "tool_calls", require: { browser_navigate: 1 } }],
	};
	const result = await scoreTask(timedTask, dir, { counts: {}, order: [] }, "TIMEOUT");
	assert.equal(result.grade, "UNGRADED");
	assert.equal(result.points, 0);
	assert.equal(result.checks.length, 1);
	const args = buildPiArgs({
		cliPath: "cli.js",
		prompt: "x",
		allowTools: ["browser_navigate", "browser_read_page", "browser_act", "write"],
		provider: "p",
		model: "m",
	});
	assert.deepEqual(args, [
		"cli.js",
		"--print",
		"--mode",
		"json",
		"--provider",
		"p",
		"--model",
		"m",
		"x",
		"--tools",
		"browser_navigate,browser_read_page,browser_act,write",
	]);
	assert.equal(args.join(",").includes("read,bash,edit"), false);
});
