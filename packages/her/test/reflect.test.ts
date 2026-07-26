import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	FakeModel,
	initStore,
	Memory,
	parseFrontmatter,
	readJson,
	readText,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-reflect-ts-"));
	await initStore(root);
	return root;
}

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

// reflect() commits to git only when it writes a recognition file (mirroring the Python reference,
// which git-commits exactly once per surfaced recognition); tests that expect a written recognition
// need a real git identity in the store first.
async function gitInit(store: string): Promise<void> {
	await git(store, "init");
	await git(store, "config", "user.name", "Her Reflect Test");
	await git(store, "config", "user.email", "her-reflect-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
}

async function writeRawEpisode(store: string, ts: string, id: string, body: string): Promise<void> {
	await writeText(
		join(store, "episodic", "raw", `${ts}--${id}.md`),
		["---", `id: ${id}`, `timestamp: ${ts}`, "project: her", "---", "", body, ""].join("\n"),
	);
}

test("reflect writes a pending recognition with correct frontmatter and returns {id, text}", async () => {
	const store = await tempStore();
	await gitInit(store);
	await writeRawEpisode(
		store,
		"2026-07-01T0900",
		"ep1",
		"Fei rewrote the same paragraph five times before shipping it.",
	);

	const model = new FakeModel("You rewrite until the words feel inevitable, not until they're merely correct.");
	const memory = new Memory(store, model);

	const result = await memory.reflect();
	assert.equal(result.ran, true);
	assert.ok(result.id);
	assert.equal(result.text, "You rewrite until the words feel inevitable, not until they're merely correct.");

	// called exactly once, at the strong tier (per the Mirror Effect spec)
	assert.equal(model.calls.length, 1);
	assert.equal(model.calls[0].strong, true);
	assert.match(model.calls[0].prompt, /Fei rewrote the same paragraph/);

	const today = new Date().toISOString().slice(0, 10);
	const fileName = `${today}--${result.id}.md`;
	const raw = await readText(join(store, "recognitions", fileName));
	assert.ok(raw);
	const parsed = parseFrontmatter(raw);
	assert.equal(parsed.data.id, result.id);
	assert.equal(parsed.data.status, "pending");
	assert.equal(parsed.data.created, today);
	assert.deepEqual(parsed.data.provenance, ["ep1"]);
	assert.equal(parsed.data.response_episode, null);
	assert.match(parsed.body, /inevitable/);

	const state = await readJson<{ last_reflect?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_reflect, today);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory: reflect recognition/);
});

test("reflect does nothing when the model replies NONE, but still advances last_reflect", async () => {
	const store = await tempStore();
	await writeRawEpisode(store, "2026-07-01T0900", "ep1", "Ordinary session, nothing surprising.");
	const model = new FakeModel("  NONE  ");

	const result = await new Memory(store, model).reflect();
	assert.equal(result.ran, true);
	assert.equal(result.id, undefined);
	assert.equal(result.text, undefined);

	const entries = (await readdir(join(store, "recognitions"))).filter((entry) => entry.endsWith(".md"));
	assert.deepEqual(entries, []);

	const today = new Date().toISOString().slice(0, 10);
	const state = await readJson<{ last_reflect?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_reflect, today);
});

test("ifDue gating skips a same-day rerun and respects a cadence override", async () => {
	const store = await tempStore();
	const model = new FakeModel("NONE");

	const first = await new Memory(store, model).reflect({ ifDue: true });
	assert.equal(first.ran, true);
	assert.equal(first.due, true);
	assert.equal(model.calls.length, 1);

	// same day, same default cadence (reflect daily) -> not due yet, model not called again
	const second = await new Memory(store, model).reflect({ ifDue: true });
	assert.equal(second.ran, false);
	assert.equal(second.due, false);
	assert.equal(model.calls.length, 1);

	// cadence override: reflect_every_days: 3 -> 1 day since last_reflect is still not due
	await writeText(join(store, ".her", "config.yaml"), "cadence:\n  reflect_every_days: 3\n");
	const oneDayAgo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	await writeJson(join(store, ".her", "state.json"), { last_reflect: oneDayAgo });
	const third = await new Memory(store, model).reflect({ ifDue: true });
	assert.equal(third.ran, false);
	assert.equal(third.due, false);
	assert.equal(model.calls.length, 1);

	// 3 days since last_reflect meets the override cadence -> due again
	const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
	await writeJson(join(store, ".her", "state.json"), { last_reflect: threeDaysAgo });
	const fourth = await new Memory(store, model).reflect({ ifDue: true });
	assert.equal(fourth.ran, true);
	assert.equal(fourth.due, true);
	assert.equal(model.calls.length, 2);
});

test("reflect throws a clear error when no model is configured", async () => {
	const store = await tempStore();
	const memory = new Memory(store);
	await assert.rejects(() => memory.reflect(), /reflect requires a model/);
});

test("existing recognitions are included in the reflect prompt", async () => {
	const store = await tempStore();
	await writeText(
		join(store, "recognitions", "2026-06-01--abc12345.md"),
		[
			"---",
			"id: abc12345",
			"status: pending",
			"created: 2026-06-01",
			"provenance:",
			"  - ep0",
			"response_episode: null",
			"---",
			"",
			"Fei always double-checks before trusting an itch that things are 'basically done'.",
			"",
		].join("\n"),
	);
	await writeRawEpisode(store, "2026-07-01T0900", "ep1", "Fei double-checked the deploy twice before announcing it.");

	const model = new FakeModel("NONE");
	await new Memory(store, model).reflect();

	assert.equal(model.calls.length, 1);
	assert.match(model.calls[0].prompt, /double-checks before trusting an itch/);
});
