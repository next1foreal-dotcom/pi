import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTasks, scoreTask, summarizeScores, type ExamTask } from "../exam/score.ts";
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
	const check: ExamTask["checks"][number] = { kind: "json_ids", file: "out.json", field: "name", pattern: "^PROD-(\\d{3})$", expectRange: [1, 53], unique: true };
	await artifact(dir, "out.json", ids);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", ids.filter((item) => item.name !== "PROD-042"));
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", [...ids, { name: "PROD-054" }]);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", [...ids.slice(0, 52), ids[0]!]);
	assert.equal((await scoreTask(task([check]), dir, { counts: {}, order: [] })).grade, "FAIL");
});

test("score json_map compares values and supports object mode modifiers", async () => {
	const dir = await outDir();
	const map: ExamTask["checks"][number] = { kind: "json_map", file: "out.json", keyField: "name", valueField: "price", expect: { "PROD-001": "$3.20", "PROD-002": "$4.20" } };
	await artifact(dir, "out.json", [{ name: "PROD-001", price: "$9.99" }, { name: "PROD-002", price: "$8.88" }]);
	assert.equal((await scoreTask(task([map]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const object: ExamTask["checks"][number] = { kind: "json_map", file: "out.json", mode: "object", expect: { Alpha: "One", Beta: "Two" } };
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
	const exact: ExamTask["checks"][number] = { kind: "json_set", file: "out.json", field: "ids", expect: ["A", "B", "C"], exact: true };
	await artifact(dir, "out.json", { ids: ["A", "B", "C"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", { ids: ["A", "B", "C", "D"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", { ids: ["A", "B"] });
	assert.equal((await scoreTask(task([exact]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const partial: ExamTask["checks"][number] = { kind: "json_set", file: "out.json", field: "ids", expect: ["A", "B", "C", "D", "E"], exact: false, partialCredit: true };
	await artifact(dir, "out.json", { ids: ["A", "B", "C"] });
	const result = await scoreTask(task([partial]), dir, { counts: {}, order: [] });
	assert.equal(result.checks[0]?.earned, 0.6);
});

test("score rows where sections and malformed artifacts fail loud", async () => {
	const dir = await outDir();
	const rows: ExamTask["checks"][number] = { kind: "json_rows", file: "out.json", exactCount: 6, requiredFields: ["name"], nonEmptyFields: ["steps"] };
	await artifact(dir, "out.json", Array.from({ length: 7 }, () => ({ name: "x", steps: ["go"] })));
	assert.equal((await scoreTask(task([rows]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const minRows: ExamTask["checks"][number] = { kind: "json_rows", file: "out.json", minCount: 10, requiredFields: ["name"] };
	await artifact(dir, "out.json", Array.from({ length: 10 }, () => ({ name: "x" })));
	assert.equal((await scoreTask(task([minRows]), dir, { counts: {}, order: [] })).grade, "PASS");
	await artifact(dir, "out.json", [{ name: "x", steps: [] }]);
	assert.equal((await scoreTask(task([{ ...rows, exactCount: 1 }]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const where: ExamTask["checks"][number] = { kind: "json_where", file: "out.json", where: { kind: "changed" }, expect: { before: "$9", after: "$11" } };
	await artifact(dir, "out.json", [{ kind: "changed", before: "$11", after: "$9" }]);
	assert.equal((await scoreTask(task([where]), dir, { counts: {}, order: [] })).grade, "FAIL");
	const sections: ExamTask["checks"][number] = { kind: "json_sections", file: "out.json", minSections: 3, factsMustInclude: ["one", "two", "three"], eachFactInSomeSection: true };
	await artifact(dir, "out.json", { sections: [{ title: "all one two three", facts: [] }, { title: "b", facts: [] }, { title: "c", facts: [] }] });
	assert.equal((await scoreTask(task([sections]), dir, { counts: {}, order: [] })).grade, "FAIL");
	await artifact(dir, "out.json", { sections: [{ title: "a", facts: ["one"] }, { title: "b", facts: ["two"] }, { title: "c", facts: ["three"] }] });
	assert.equal((await scoreTask(task([sections]), dir, { counts: {}, order: [] })).grade, "PASS");
	assert.match((await scoreTask(task([{ ...rows, file: "missing.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ?? "", /missing/i);
	await writeFile(join(dir, "bad.json"), "{", "utf8");
	assert.match((await scoreTask(task([{ ...rows, file: "bad.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ?? "", /invalid JSON/i);
	await artifact(dir, "object.json", {});
	assert.match((await scoreTask(task([{ ...rows, file: "object.json" }]), dir, { counts: {}, order: [] })).checks[0]?.detail ?? "", /type/i);
});

test("tool evidence vetoes artifacts and transcript parsing fails loud", async () => {
	const dir = await outDir();
	await artifact(dir, "out.json", []);
	const result = await scoreTask(task([{ kind: "tool_calls", require: { browser_navigate: 1 } }]), dir, { counts: {}, order: [] });
	assert.equal(result.grade, "FAIL");
	const parsed = parseToolCalls('{"type":"session_start"}\n{"type":"tool_execution_start","toolName":"browser_navigate","args":{}}\n{"type":"tool_execution_start","toolName":"write","args":{}}');
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
	assert.equal(tasks.tasks.some((item) => item.id === "T11"), false);
	assert.deepEqual(tasks.toolPolicy.allow, ["browser_navigate", "browser_read_page", "browser_act", "write"]);
	assert.throws(() => loadTasks({ tasks: [{ category: "scrape" }] }), /id/);
});
