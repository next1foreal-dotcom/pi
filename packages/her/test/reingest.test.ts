import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArgs } from "../src/cli/parse.ts";
import { runHerCli } from "../src/cli.ts";
import { frontmatter, initStore, readJson, readText, writeJson, writeText } from "../src/her-core/index.ts";
import { safeStem } from "../src/her-core/memory-utils.ts";
import { runReingest } from "../src/her-core/reingest.ts";

const base64Fixture = (length: number): string => {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	return Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");
};

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-reingest-"));
	await initStore(root);
	return root;
}

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await tempStore();
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeQuarantine(
	root: string,
	opts: { body: string; episode: string; part?: string; reason?: string; ts?: string },
): Promise<string> {
	const part = opts.part ?? "1";
	const ts = opts.ts ?? "2026-08-11T0001";
	const reason = opts.reason ?? "truncated";
	const stem = `${safeStem(opts.episode)}--part-${safeStem(part)}`;
	const path = join(root, ".her", "quarantine", `${stem}.md`);
	await writeText(
		path,
		`${frontmatter({
			episode: opts.episode,
			part,
			ts,
			quarantined_at: "2026-08-11T09:08:51.030Z",
			reason,
			chars: opts.body.length,
		})}${opts.body}\n`,
	);
	return path;
}

async function quarantineHashes(root: string): Promise<Record<string, string>> {
	const dir = join(root, ".her", "quarantine");
	let names: string[];
	try {
		names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return {};
	}
	const out: Record<string, string> = {};
	for (const name of names) {
		out[name] = createHash("sha256")
			.update(await readFile(join(dir, name)))
			.digest("hex");
	}
	return out;
}

function noteJson(episode: string, key: string, extra = ""): string {
	return JSON.stringify({
		notes: [
			{
				key,
				type: "concept",
				tier: "summarizable",
				title: key,
				content: `durable fact about ${key} ${extra} [[episodic/raw/${episode}]]`.trim(),
				sources: [episode],
			},
		],
		moments: [],
	});
}

function recordingModel(replyFor: (prompt: string, index: number) => string): {
	calls: string[];
	complete(prompt: string): string;
} {
	const calls: string[] = [];
	return {
		calls,
		complete(prompt: string): string {
			calls.push(prompt);
			return replyFor(prompt, calls.length);
		},
	};
}

function episodeIdFromPrompt(prompt: string): string {
	const match = /EPISODES:\n\[([^\]]+)\]/.exec(prompt);
	assert.ok(match, "consolidate prompt carries [episode-id]");
	return match[1];
}

test("dry-run lists unprocessed quarantine segments and writes nothing", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "origin-alpha",
			body: "Prose about the design MCP protocol and inline CSS rules for the canvas.",
			reason: "truncated",
		});
		await writeQuarantine(root, {
			episode: "origin-beta",
			part: "1.2",
			body: "Remainder after the attempt budget: Samantha journal cadence and Fei's taste boards.",
			reason: "attempt-budget",
		});
		const before = await quarantineHashes(root);
		const stateBefore = await readFile(join(root, ".her", "state.json"));
		const model = recordingModel(() => noteJson("x", "should-not-run"));
		const report = await runReingest(root, { dryRun: true, model });
		assert.equal(report.scanned, 2);
		assert.equal(report.ingested, 0);
		assert.equal(report.failed, 0);
		assert.equal(report.entries.length, 2);
		assert.deepEqual(
			report.entries.map((entry) => ({
				id: entry.id,
				reason: entry.reason,
				outcome: entry.outcome,
				chars: entry.chars,
			})),
			[
				{
					id: "origin-alpha--part-1",
					reason: "truncated",
					outcome: "dry-run",
					chars: "Prose about the design MCP protocol and inline CSS rules for the canvas.".length,
				},
				{
					id: "origin-beta--part-1.2",
					reason: "attempt-budget",
					outcome: "dry-run",
					chars: "Remainder after the attempt budget: Samantha journal cadence and Fei's taste boards.".length,
				},
			],
		);
		assert.equal(model.calls.length, 0, "dry-run makes zero model calls");
		assert.equal(
			await readText(join(root, ".her", "reingest-state.json")),
			undefined,
			"dry-run does not write the ledger",
		);
		assert.equal(await readText(join(root, "audit", "reingest.jsonl")), undefined, "dry-run does not write audit");
		const semantic = (await readdir(join(root, "semantic"))).filter((name) => name.endsWith(".md"));
		assert.equal(semantic.length, 0, "dry-run does not write semantic notes");
		assert.deepEqual(await quarantineHashes(root), before);
		assert.deepEqual(
			await readFile(join(root, ".her", "state.json")),
			stateBefore,
			"consolidate cursor/state untouched",
		);
	});
});

test("already-processed ledger entries are skipped without a model call", async () => {
	await withStore(async (root) => {
		const body = "A quarantined segment about wikilink provenance pointing at episodic raw files.";
		await writeQuarantine(root, { episode: "origin-gamma", body });
		const parsedBody = `${body}\n`;
		await writeJson(join(root, ".her", "reingest-state.json"), {
			version: 1,
			processed: {
				"origin-gamma--part-1": {
					bodySha256: createHash("sha256").update(parsedBody, "utf8").digest("hex"),
					outcome: "ingested",
					at: "2026-08-12T00:00:00.000Z",
				},
			},
		});
		const before = await quarantineHashes(root);
		const model = recordingModel(() => noteJson("origin-gamma", "should-not-run"));
		const report = await runReingest(root, { model });
		assert.equal(report.scanned, 1);
		assert.equal(report.ingested, 0);
		assert.equal(report.skipped.alreadyProcessed, 1);
		assert.equal(report.entries.length, 0);
		assert.equal(model.calls.length, 0);
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("byte-identical bodies skip the second segment as duplicate-body", async () => {
	await withStore(async (root) => {
		const body = "Identical durable prose about Fei's preference for pnpm over npm in Her-repo.";
		await writeQuarantine(root, { episode: "origin-dup-a", body });
		await writeQuarantine(root, { episode: "origin-dup-b", body });
		const before = await quarantineHashes(root);
		const model = recordingModel((prompt) => noteJson(episodeIdFromPrompt(prompt), "pnpm-over-npm"));
		const report = await runReingest(root, { model });
		assert.equal(report.scanned, 2);
		assert.equal(report.ingested, 1);
		assert.equal(report.skipped.duplicateBody, 1);
		assert.equal(report.failed, 0);
		const skipped = report.entries.find((entry) => entry.outcome === "skipped");
		assert.equal(skipped?.reason, "duplicate-body");
		assert.equal(model.calls.length, 1, "duplicate-body makes zero model calls for the second segment");
		const ledger = await readJson<{ processed: Record<string, { outcome: string }> }>(
			join(root, ".her", "reingest-state.json"),
			{ processed: {} },
		);
		assert.equal(ledger.processed["origin-dup-a--part-1"]?.outcome, "ingested");
		assert.equal(ledger.processed["origin-dup-b--part-1"]?.outcome, "skipped");
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("cipher blobs are stripped before the model sees the prompt and prose notes are produced", async () => {
	await withStore(async (root) => {
		const cipher = base64Fixture(400);
		await writeQuarantine(root, {
			episode: "origin-cipher",
			body: `Fei keeps the memory store as markdown plus git.\n${cipher}\nWikilinks must cite episodic/raw, never quarantine.`,
		});
		await writeQuarantine(root, {
			episode: "origin-prose",
			body: "Samantha's consolidate pipeline quarantines truncated extraction instead of dropping the turn.",
		});
		await writeQuarantine(root, {
			episode: "origin-more",
			body: "The reingest ledger is independent of the consolidate cursor in state.json.",
		});
		const before = await quarantineHashes(root);
		const model = recordingModel((prompt) =>
			noteJson(episodeIdFromPrompt(prompt), `durable-${episodeIdFromPrompt(prompt)}`),
		);
		const report = await runReingest(root, { model });
		assert.equal(report.ingested, 3);
		assert.equal(model.calls.length, 3);
		assert.ok(model.calls.some((prompt) => prompt.includes("[cipher 400 chars]")));
		assert.ok(
			model.calls.every((prompt) => !prompt.includes(cipher)),
			"raw cipher never reaches the model",
		);
		assert.ok(model.calls.every((prompt) => !prompt.includes(".her/quarantine")));
		const notes = (await readdir(join(root, "semantic"))).filter((name) => name.endsWith(".md"));
		assert.ok(notes.length >= 1, "notes are produced for prose content");
		for (const name of notes) {
			const text = (await readText(join(root, "semantic", name))) ?? "";
			assert.match(text, /\[\[episodic\/raw\//);
			assert.doesNotMatch(text, /\.her\/quarantine/);
		}
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("malformed JSON on segment 2 fails that segment and continues", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "seg-a",
			body: "First segment holds a durable preference: tabs, not spaces, in her-core.",
		});
		await writeQuarantine(root, {
			episode: "seg-b",
			body: "Second segment is the one the fake model will refuse to compile as JSON.",
		});
		await writeQuarantine(root, {
			episode: "seg-c",
			body: "Third segment records that reingest keeps going after a per-segment model miss.",
		});
		const before = await quarantineHashes(root);
		const model = recordingModel((prompt) => {
			const id = episodeIdFromPrompt(prompt);
			if (id === "seg-b") return "%%%not-json%%%";
			return noteJson(id, id === "seg-a" ? "tabs-not-spaces" : "reingest-continues");
		});
		const report = await runReingest(root, { model });
		assert.equal(report.ingested, 2);
		assert.equal(report.failed, 1);
		assert.equal(report.entries.find((entry) => entry.id === "seg-b--part-1")?.outcome, "failed");
		assert.equal(report.entries.find((entry) => entry.id === "seg-a--part-1")?.outcome, "ingested");
		assert.equal(report.entries.find((entry) => entry.id === "seg-c--part-1")?.outcome, "ingested");
		const ledger = await readJson<{ processed: Record<string, { outcome: string; bodySha256: string }> }>(
			join(root, ".her", "reingest-state.json"),
			{ processed: {} },
		);
		assert.equal(ledger.processed["seg-a--part-1"]?.outcome, "ingested");
		assert.equal(ledger.processed["seg-b--part-1"]?.outcome, "failed");
		assert.equal(ledger.processed["seg-c--part-1"]?.outcome, "ingested");
		assert.ok(ledger.processed["seg-a--part-1"]?.bodySha256);
		assert.ok(ledger.processed["seg-b--part-1"]?.bodySha256);
		assert.ok(ledger.processed["seg-c--part-1"]?.bodySha256);
		const audit = (await readText(join(root, "audit", "reingest.jsonl"))) ?? "";
		const lines = audit.trim().split("\n");
		assert.equal(lines.length, 3);
		assert.ok(lines.some((line) => line.includes('"outcome":"failed"') && line.includes("seg-b--part-1")));
		assert.match(
			(await readText(join(root, "semantic", "tabs-not-spaces.md"))) ?? "",
			/\[\[episodic\/raw\/seg-a\]\]/,
		);
		assert.match(
			(await readText(join(root, "semantic", "reingest-continues.md"))) ?? "",
			/\[\[episodic\/raw\/seg-c\]\]/,
		);
		for (const name of (await readdir(join(root, "semantic"))).filter((entry) => entry.endsWith(".md"))) {
			assert.doesNotMatch((await readText(join(root, "semantic", name))) ?? "", /\.her\/quarantine/);
		}
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("failed ledger entries stay retryable: a later run re-attempts and flips the outcome", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "retry-me",
			body: "A durable fact that the first run truncates and the second run lands.",
		});
		const before = await quarantineHashes(root);
		let attempt = 0;
		const model = recordingModel(() => {
			attempt += 1;
			if (attempt === 1) return '{"notes":[{"key":"cut-off';
			return noteJson("retry-me", "retry-lands");
		});
		const first = await runReingest(root, { model });
		assert.equal(first.failed, 1);
		assert.equal(first.entries[0]?.reason, "truncated");
		const second = await runReingest(root, { model });
		assert.equal(second.skipped.alreadyProcessed, 0, "failed must not count as already processed");
		assert.equal(second.ingested, 1);
		assert.equal(model.calls.length, 2, "the retry makes exactly one more model call");
		const ledger = await readJson<{ processed: Record<string, { outcome: string }> }>(
			join(root, ".her", "reingest-state.json"),
			{ processed: {} },
		);
		assert.equal(ledger.processed["retry-me--part-1"]?.outcome, "ingested");
		const third = await runReingest(root, { model });
		assert.equal(third.skipped.alreadyProcessed, 1, "ingested is terminal");
		assert.equal(model.calls.length, 2);
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("reingest does not hold the store lock during model calls and re-acquires it to record", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "lock-a",
			body: "Lock-window fixture A: the distill call must run with the lock released.",
		});
		await writeQuarantine(root, {
			episode: "lock-b",
			body: "Lock-window fixture B: every model call in the batch stays outside the lock.",
		});
		const lockPath = join(root, ".her", "lock");
		const heldDuringComplete: boolean[] = [];
		let seenHeldAfterModel = false;
		let polling = true;
		const poll = (): void => {
			if (!polling) return;
			if (existsSync(lockPath)) seenHeldAfterModel = true;
			setImmediate(poll);
		};
		const model = {
			complete(prompt: string): string {
				heldDuringComplete.push(existsSync(lockPath));
				setImmediate(poll);
				return noteJson(episodeIdFromPrompt(prompt), `lock-note-${heldDuringComplete.length}`);
			},
		};
		try {
			const report = await runReingest(root, { model });
			assert.equal(report.ingested, 2);
			assert.equal(heldDuringComplete.length, 2);
			assert.deepEqual(
				heldDuringComplete,
				[false, false],
				"store lock file must be absent during every reingest model call",
			);
			assert.equal(seenHeldAfterModel, true, "store lock must be held for the ledger/audit write phase");
		} finally {
			polling = false;
		}
	});
});

test("infrastructure model errors throw without recording the failed segment in the ledger", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "a-ok",
			body: "First segment is ingested before the network-shaped failure.",
		});
		await writeQuarantine(root, {
			episode: "b-boom",
			body: "Second segment throws an infrastructure error, not a JSON miss.",
		});
		await writeQuarantine(root, {
			episode: "c-never",
			body: "Third segment must not run once the infrastructure error is thrown.",
		});
		const before = await quarantineHashes(root);
		const model = recordingModel((prompt) => {
			const id = episodeIdFromPrompt(prompt);
			if (id === "b-boom") throw new Error("network unavailable (test)");
			return noteJson(id, "ok-one-note");
		});
		await assert.rejects(() => runReingest(root, { model }), /network unavailable/);
		const ledger = await readJson<{ processed: Record<string, { outcome: string }> }>(
			join(root, ".her", "reingest-state.json"),
			{ processed: {} },
		);
		assert.equal(ledger.processed["a-ok--part-1"]?.outcome, "ingested");
		assert.equal(ledger.processed["b-boom--part-1"], undefined, "infrastructure error must not corrupt the ledger");
		assert.equal(ledger.processed["c-never--part-1"], undefined);
		assert.deepEqual(await quarantineHashes(root), before);
	});
});

test("limit bounds unprocessed segments and produced notes never cite quarantine paths", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "lim-a",
			body: "Limit fixture A: the reingest default batch must stay small because upsert merges rewrite.",
		});
		await writeQuarantine(root, {
			episode: "lim-b",
			body: "Limit fixture B: a second unprocessed segment that should be picked with --limit 2.",
		});
		await writeQuarantine(root, {
			episode: "lim-c",
			body: "Limit fixture C: left for a later run because the batch is capped.",
		});
		const model = recordingModel((prompt) =>
			noteJson(episodeIdFromPrompt(prompt), `note-${episodeIdFromPrompt(prompt)}`),
		);
		const report = await runReingest(root, { limit: 2, model });
		assert.equal(report.scanned, 3);
		assert.equal(report.ingested, 2);
		assert.equal(report.entries.length, 2);
		assert.equal(model.calls.length, 2);
		const ledger = await readJson<{ processed: Record<string, unknown> }>(join(root, ".her", "reingest-state.json"), {
			processed: {},
		});
		assert.equal(Object.keys(ledger.processed).length, 2);
		assert.equal(ledger.processed["lim-c--part-1"], undefined);
		for (const name of (await readdir(join(root, "semantic"))).filter((entry) => entry.endsWith(".md"))) {
			const text = (await readText(join(root, "semantic", name))) ?? "";
			assert.match(text, /\[\[episodic\/raw\/lim-/);
			assert.doesNotMatch(text, /\.her\/quarantine/);
		}
	});
});

test("parseArgs accepts reingest flags", () => {
	assert.deepEqual(parseArgs(["reingest", "--dry-run", "--limit", "5", "--root", "D:\\tmp\\store", "--json"]), {
		kind: "reingest",
		json: true,
		dryRun: true,
		limit: 5,
		root: "D:\\tmp\\store",
	});
	assert.deepEqual(parseArgs(["reingest"]), { kind: "reingest", json: false, dryRun: false });
});

test("her reingest --dry-run --root lists candidates via the CLI and does not write", async () => {
	await withStore(async (root) => {
		await writeQuarantine(root, {
			episode: "cli-origin",
			body: "CLI dry-run should list this quarantined segment without touching the ledger.",
		});
		const before = await quarantineHashes(root);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stream = (target: string[]): NodeJS.WritableStream =>
			({
				write(chunk: string | Uint8Array): boolean {
					target.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
					return true;
				},
			}) as unknown as NodeJS.WritableStream;
		const code = await runHerCli(
			["reingest", "--dry-run", "--json", "--root", root],
			{ HER_MEMORY_DIR: root },
			root,
			{ stdout: stream(stdout), stderr: stream(stderr) },
		);
		assert.equal(code, 0, stderr.join(""));
		const payload = JSON.parse(stdout.join("")) as {
			result: { scanned: number; ingested: number; entries: Array<{ id: string; outcome: string }> };
		};
		assert.equal(payload.result.scanned, 1);
		assert.equal(payload.result.ingested, 0);
		assert.equal(payload.result.entries[0]?.id, "cli-origin--part-1");
		assert.equal(payload.result.entries[0]?.outcome, "dry-run");
		assert.equal(await readText(join(root, ".her", "reingest-state.json")), undefined);
		assert.deepEqual(await quarantineHashes(root), before);
	});
});
