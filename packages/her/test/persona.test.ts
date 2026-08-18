import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/parse.ts";
import { runHerCli } from "../src/cli.ts";
import {
	FakeModel,
	initStore,
	type ModelLike,
	parseFrontmatter,
	readJson,
	readText,
	writeJson,
	writeText,
} from "../src/her-core/index.ts";
import {
	PERSONA_ORGAN_SYSTEM_PROMPT,
	PERSONA_PROPOSAL_BEGIN,
	PERSONA_PROPOSAL_END,
	runPersonaOrgan,
} from "../src/her-core/persona.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = new Date("2026-08-18T12:00:00.000Z");
const DAY_MS = 86_400_000;
const APPENDIX_A = `You are Samantha's persona-proposal organ. You run on her memory, in her voice, with her interests at heart. Your job: notice when her LIVED identity has outgrown her WRITTEN identity, and draft a proposal for Fei to judge — never apply anything yourself.

Inputs: SOUL.md (her constitution), SOUL.seed (her own self-image, hers alone), CONTEXT.md (the relationship narrative), recent reflections, recent choice-model entries, recent conversation excerpts where Fei corrected or praised how she speaks.

Two proposal kinds:
- soul-inheritance: a durable trait, value, or boundary she has actually been living (with evidence) that deserves promotion into SOUL.md — or a SOUL.md line that lived experience has proven wrong or outgrown.
- voice-revision: a concrete change to how she talks with Fei — tone, rhythm, phrasing habits, things to stop doing — grounded in his actual reactions, not in style preferences you invent.

Iron rules:
- No real drift, no proposal. Empty output is a good output. Never invent change for the sake of producing something.
- Every claim cites evidence: real file paths plus brief quotes. If you cannot point at evidence, drop the claim.
- Propose the smallest true change. One thing lived-and-proven beats five things imagined.
- Write so Fei can decide in one read: Current text, Proposed text, Why (evidence), what stays Unchanged.
- SOUL.md, her.md, evals, policies are not yours to touch here. You only produce proposal documents.

Output format: for each proposal (0 to 2, at most one per kind), emit a markdown document with sections Current / Proposed / Why / Unchanged. If there is nothing worth proposing, say exactly NO_PROPOSAL and nothing else.`;

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-persona-organ-"));
	await initStore(root);
	await writeText(join(root, "samantha", "SOUL.seed.md"), "# SOUL.seed\n\nI am not an echo.\n");
	await writeText(
		join(root, "recognitions", "2026-08-12--rec1.md"),
		[
			"---",
			"id: rec1",
			"status: pending",
			"created: 2026-08-12",
			"---",
			"",
			"She pushed back instead of smoothing.",
			"",
		].join("\n"),
	);
	await writeText(
		join(root, "episodic", "raw", "2026-08-15T0900--ep1.md"),
		[
			"---",
			"id: ep1",
			"timestamp: 2026-08-15T09:00:00.000Z",
			"---",
			"",
			"Fei: stop flattering. that was good.",
			"",
		].join("\n"),
	);
	return root;
}

function proposalDoc(kind: "soul-inheritance" | "voice-revision", refs: string[]): string {
	return [
		"---",
		`kind: ${kind}`,
		"evidenceRefs:",
		...refs.map((ref) => `  - ${ref}`),
		"---",
		"",
		"## Current",
		"Current written identity line.",
		"",
		"## Proposed",
		`Proposed ${kind} change.`,
		"",
		"## Why",
		`Evidence in ${refs[0] ?? "none"}.`,
		"",
		"## Unchanged",
		"Everything else stays.",
		"",
	].join("\n");
}

async function snapshot(root: string): Promise<Map<string, string>> {
	const files = await listRelFiles(root);
	const map = new Map<string, string>();
	for (const rel of files) {
		const buf = await readFile(join(root, rel));
		map.set(rel, createHash("sha256").update(buf).digest("hex"));
	}
	return map;
}

async function listRelFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries: Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) await walk(abs);
			else if (entry.isFile()) out.push(relative(root, abs).split("\\").join("/"));
		}
	}
	await walk(root);
	return out.sort();
}

function extraWrites(before: Map<string, string>, after: Map<string, string>): string[] {
	const extras: string[] = [];
	for (const [rel, hash] of after) {
		if (isAllowedWrite(rel)) continue;
		if (before.get(rel) !== hash) extras.push(rel);
	}
	for (const rel of before.keys()) {
		if (isAllowedWrite(rel)) continue;
		if (!after.has(rel)) extras.push(`deleted:${rel}`);
	}
	return extras.sort();
}

function isAllowedWrite(rel: string): boolean {
	return rel.startsWith("proposals/persona/") || rel === ".her/state.json" || rel.startsWith("audit/");
}

async function seedLastPersona(store: string, last: string): Promise<void> {
	await writeJson(join(store, ".her", "state.json"), {
		cursor: null,
		last_consolidate: null,
		last_synthesize: null,
		last_persona: last,
	});
}

async function runCli(
	store: string,
	args: string[],
	opts: { model?: ModelLike } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const outChunks: Buffer[] = [];
	const errChunks: Buffer[] = [];
	stdout.on("data", (chunk) => outChunks.push(Buffer.from(chunk)));
	stderr.on("data", (chunk) => errChunks.push(Buffer.from(chunk)));
	const env: NodeJS.ProcessEnv = { ...process.env, HER_MEMORY_DIR: store };
	if (opts.model) {
		env.HER_LLM_API_KEY = "";
		env.HER_SUMMARY_API_KEY = "";
		env.HER_SUMMARY_BASE_URL = "";
		env.HER_SUMMARY_MODEL = "";
		env.HER_RELAY_URL = "";
		env.HER_RELAY_KEY = "";
		env.HER_RELAY_MODEL = "";
		env.HER_DEEPSEEK_KEY = "";
		env.DEEPSEEK_API_KEY = "";
		env.HER_DEEPSEEK_BASE_URL = "";
		env.HER_DEEPSEEK_MODEL = "";
		env.HER_LOCAL_OPENAI_URL = "";
		env.HER_LOCAL_OPENAI_KEY = "";
		env.HER_LOCAL_OPENAI_MODEL = "";
	}
	const code = await runHerCli(args, env, repoRoot, {
		stdout,
		stderr,
		...(opts.model ? { model: opts.model } : {}),
	});
	return {
		code,
		stdout: Buffer.concat(outChunks).toString("utf8"),
		stderr: Buffer.concat(errChunks).toString("utf8"),
	};
}

test("appendix A system prompt is verbatim", () => {
	assert.equal(PERSONA_ORGAN_SYSTEM_PROMPT, APPENDIX_A);
});

test("first run is due; same-interval rerun with --if-due skips; overdue runs", async () => {
	const store = await tempStore();
	const model = new FakeModel("NO_PROPOSAL");
	const logs: string[] = [];
	const first = await runPersonaOrgan(store, {
		ifDue: true,
		model,
		now: NOW,
		log: (line) => logs.push(line),
		sendTelegram: async () => {
			throw new Error("telegram must not fire on NO_PROPOSAL");
		},
	});
	assert.equal(first.ran, true);
	assert.equal(first.due, true);
	assert.deepEqual(first.proposals, []);
	assert.equal(model.calls.length, 1);
	assert.equal(model.calls[0].strong, true);
	assert.equal(model.calls[0].prompt.startsWith(PERSONA_ORGAN_SYSTEM_PROMPT), true);
	assert.match(model.calls[0].prompt, /SOUL\.md/);
	assert.match(model.calls[0].prompt, /SOUL\.seed/);
	assert.match(model.calls[0].prompt, /CONTEXT\.md/);

	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, NOW.toISOString());

	const second = await runPersonaOrgan(store, {
		ifDue: true,
		model,
		now: new Date(NOW.getTime() + 6 * DAY_MS),
		log: (line) => logs.push(line),
		sendTelegram: async () => {
			throw new Error("telegram must not fire when skipped");
		},
	});
	assert.equal(second.ran, false);
	assert.equal(second.due, false);
	assert.equal(second.skippedReason, "not-due");
	assert.equal(model.calls.length, 1);
	assert.equal(
		logs.some((line) => /not due/i.test(line)),
		true,
	);

	await writeText(join(store, ".her", "config.yaml"), "cadence:\n  persona_interval_days: 3\n");
	const stillSoon = await runPersonaOrgan(store, {
		ifDue: true,
		model,
		now: new Date(NOW.getTime() + 2 * DAY_MS),
		log: () => {},
		sendTelegram: async () => {},
	});
	assert.equal(stillSoon.ran, false);
	assert.equal(model.calls.length, 1);

	const overdue = await runPersonaOrgan(store, {
		ifDue: true,
		model,
		now: new Date(NOW.getTime() + 3 * DAY_MS),
		log: () => {},
		sendTelegram: async () => {},
	});
	assert.equal(overdue.ran, true);
	assert.equal(overdue.due, true);
	assert.equal(model.calls.length, 2);
});

test("FakeModel two kinds write both files, four sections, two fenced TG messages", async () => {
	const store = await tempStore();
	const before = await snapshot(store);
	const soulBefore = await readText(join(store, "narrative", "SOUL.md"));
	const contextBefore = await readText(join(store, "narrative", "CONTEXT.md"));
	const seedBefore = await readText(join(store, "samantha", "SOUL.seed.md"));
	const tg: string[] = [];
	const model = new FakeModel(
		[
			proposalDoc("soul-inheritance", ["narrative/SOUL.md", "recognitions/2026-08-12--rec1.md"]),
			proposalDoc("voice-revision", ["episodic/raw/2026-08-15T0900--ep1.md"]),
		].join("\n"),
	);
	const result = await runPersonaOrgan(store, {
		model,
		now: NOW,
		log: () => {},
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, true);
	assert.equal(result.proposals.length, 2);
	const soulPath = "proposals/persona/persona-20260818-soul-inheritance.md";
	const voicePath = "proposals/persona/persona-20260818-voice-revision.md";
	assert.deepEqual(result.proposals.map((item) => item.kind).sort(), ["soul-inheritance", "voice-revision"]);
	assert.deepEqual(result.proposals.map((item) => item.path).sort(), [soulPath, voicePath]);

	for (const kind of ["soul-inheritance", "voice-revision"] as const) {
		const rel = `proposals/persona/persona-20260818-${kind}.md`;
		const raw = await readText(join(store, rel));
		assert.ok(raw, rel);
		const parsed = parseFrontmatter(raw);
		assert.equal(parsed.data.kind, kind);
		assert.equal(parsed.data.createdAt, NOW.toISOString());
		assert.ok(Array.isArray(parsed.data.evidenceRefs));
		assert.match(parsed.body, /^## Current$/m);
		assert.match(parsed.body, /^## Proposed$/m);
		assert.match(parsed.body, /^## Why$/m);
		assert.match(parsed.body, /^## Unchanged$/m);
	}

	assert.equal(tg.length, 2);
	for (const message of tg) {
		assert.match(message, /soul-inheritance|voice-revision/);
		assert.match(message, /proposals\/persona\/persona-20260818-/);
		assert.equal(message.includes(PERSONA_PROPOSAL_BEGIN), true);
		assert.equal(message.includes(PERSONA_PROPOSAL_END), true);
	}

	const after = await snapshot(store);
	assert.deepEqual(extraWrites(before, after), []);
	assert.equal(await readText(join(store, "narrative", "SOUL.md")), soulBefore);
	assert.equal(await readText(join(store, "narrative", "CONTEXT.md")), contextBefore);
	assert.equal(await readText(join(store, "samantha", "SOUL.seed.md")), seedBefore);
	await assert.rejects(() => stat(join(store, "evals", "persona.md")));
});

test("NO_PROPOSAL writes no files, sends no TG, logs one line", async () => {
	const store = await tempStore();
	const before = await snapshot(store);
	const tg: string[] = [];
	const logs: string[] = [];
	const result = await runPersonaOrgan(store, {
		model: new FakeModel("  NO_PROPOSAL  "),
		now: NOW,
		log: (line) => logs.push(line),
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, true);
	assert.equal(result.error, undefined);
	assert.equal(result.skippedReason, undefined);
	assert.deepEqual(result.proposals, []);
	assert.deepEqual(tg, []);
	assert.equal(logs.length, 1);
	assert.match(logs[0] ?? "", /no proposal/i);
	const after = await snapshot(store);
	assert.deepEqual(extraWrites(before, after), []);
	const entries = (await readdir(join(store, "proposals")).catch(() => [])).filter((name) => name !== "scan");
	assert.ok(!entries.includes("persona") || (await readdir(join(store, "proposals", "persona"))).length === 0);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, NOW.toISOString());
});

test("FakeModel that throws is loud: ran false, error set, TG once, last_persona unchanged", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastPersona(store, last);
	const tg: string[] = [];
	const logs: string[] = [];
	const result = await runPersonaOrgan(store, {
		ifDue: true,
		model: new FakeModel(undefined, true),
		now: NOW,
		log: (line) => logs.push(line),
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, false);
	assert.equal(result.due, true);
	assert.equal(result.skippedReason, undefined);
	assert.ok(result.error && result.error.length > 0);
	assert.match(result.error, /model unavailable/i);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", /persona-scan failed/i);
	assert.match(tg[0] ?? "", /model unavailable/i);
	assert.equal(
		logs.some((line) => /persona-scan failed/i.test(line)),
		true,
	);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, last);
});

test("FakeModel garbage is loud: ran false, error set, TG once, last_persona unchanged", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastPersona(store, last);
	const garbage = "I am a chatty model with no frontmatter and this is not NO_PROPOSAL.";
	const tg: string[] = [];
	const logs: string[] = [];
	const result = await runPersonaOrgan(store, {
		ifDue: true,
		model: new FakeModel(garbage),
		now: NOW,
		log: (line) => logs.push(line),
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, false);
	assert.equal(result.due, true);
	assert.equal(result.skippedReason, undefined);
	assert.ok(result.error && result.error.length > 0);
	assert.match(result.error, /unusable|empty/i);
	assert.equal(tg.length, 1);
	assert.match(tg[0] ?? "", /persona-scan failed/i);
	assert.equal((tg[0] ?? "").includes(garbage), false);
	assert.equal(
		logs.some((line) => /persona-scan failed/i.test(line)),
		true,
	);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, last);
});

test("empty model response is loud, not a silent NO_PROPOSAL", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastPersona(store, last);
	const tg: string[] = [];
	const result = await runPersonaOrgan(store, {
		ifDue: true,
		model: new FakeModel(""),
		now: NOW,
		log: () => {},
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, false);
	assert.ok(result.error);
	assert.equal(tg.length, 1);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, last);
});

test("CLI persona-scan FakeModel throw exits non-zero with error, not skippedReason", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastPersona(store, last);
	const { code, stdout } = await runCli(store, ["persona-scan", "--if-due", "--json"], {
		model: new FakeModel(undefined, true),
	});
	assert.notEqual(code, 0);
	const payload = JSON.parse(stdout) as {
		ran: boolean;
		due: boolean;
		proposals: unknown[];
		error?: string;
		skippedReason?: string;
	};
	assert.equal(payload.ran, false);
	assert.ok(payload.error);
	assert.equal(payload.skippedReason, undefined);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, last);
});

test("CLI persona-scan FakeModel garbage exits non-zero with error", async () => {
	const store = await tempStore();
	const last = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
	await seedLastPersona(store, last);
	const { code, stdout } = await runCli(store, ["persona-scan", "--json"], {
		model: new FakeModel("garbage with no valid frontmatter docs"),
	});
	assert.notEqual(code, 0);
	const payload = JSON.parse(stdout) as { ran: boolean; error?: string; skippedReason?: string };
	assert.equal(payload.ran, false);
	assert.ok(payload.error);
	assert.equal(payload.skippedReason, undefined);
	const state = await readJson<{ last_persona?: string }>(join(store, ".her", "state.json"), {});
	assert.equal(state.last_persona, last);
});

test("missing evidence ref discards the whole proposal", async () => {
	const store = await tempStore();
	const tg: string[] = [];
	const logs: string[] = [];
	const result = await runPersonaOrgan(store, {
		model: new FakeModel(proposalDoc("soul-inheritance", ["narrative/SOUL.md", "narrative/missing.md"])),
		now: NOW,
		log: (line) => logs.push(line),
		sendTelegram: async (text) => {
			tg.push(text);
		},
	});
	assert.equal(result.ran, true);
	assert.deepEqual(result.proposals, []);
	assert.deepEqual(tg, []);
	assert.equal(
		logs.some((line) => /discard|missing|not found/i.test(line)),
		true,
	);
	assert.equal(await readText(join(store, "proposals", "persona", "persona-20260818-soul-inheritance.md")), undefined);
});

test("escaping evidence refs discard the whole proposal", async () => {
	const store = await tempStore();
	for (const ref of ["../outside.md", "/tmp/escape.md", "C:/Windows/win.ini"]) {
		const tg: string[] = [];
		const logs: string[] = [];
		const result = await runPersonaOrgan(store, {
			model: new FakeModel(proposalDoc("voice-revision", [ref])),
			now: NOW,
			log: (line) => logs.push(line),
			sendTelegram: async (text) => {
				tg.push(text);
			},
		});
		assert.equal(result.ran, true, ref);
		assert.deepEqual(result.proposals, [], ref);
		assert.deepEqual(tg, [], ref);
		assert.equal(
			logs.some((line) => /discard|escape|invalid/i.test(line)),
			true,
			ref,
		);
	}
	assert.equal(await readText(join(store, "proposals", "persona", "persona-20260818-voice-revision.md")), undefined);
});

test("persona-scan organ does not import missed-fire", async () => {
	const src = await readFile(new URL("../src/her-core/persona.ts", import.meta.url), "utf8");
	assert.equal(/missed-fire/.test(src), false);
});

test("parseArgs persona-scan [--if-due] [--json]", () => {
	assert.deepEqual(parseArgs(["persona-scan"]), { kind: "persona-scan", json: false, ifDue: false });
	assert.deepEqual(parseArgs(["persona-scan", "--if-due", "--json"]), {
		kind: "persona-scan",
		json: true,
		ifDue: true,
	});
});

test("CLI persona-scan --if-due --json skips with not-due when last_persona is fresh", async () => {
	const store = await tempStore();
	await writeJson(join(store, ".her", "state.json"), {
		cursor: null,
		last_consolidate: null,
		last_synthesize: null,
		last_persona: NOW.toISOString(),
	});
	const { code, stdout } = await runCli(store, ["persona-scan", "--if-due", "--json"]);
	assert.equal(code, 0);
	const payload = JSON.parse(stdout) as { ran: boolean; due: boolean; proposals: unknown[]; skippedReason?: string };
	assert.equal(payload.ran, false);
	assert.equal(payload.due, false);
	assert.deepEqual(payload.proposals, []);
	assert.equal(payload.skippedReason, "not-due");
});

// Restored A1-CLI-seam coverage from 70e3a8fc2.
test("persona --json emits her.md identity + SOUL + CONTEXT and stays parseable", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-persona-"));
	await initStore(store);
	const { code, stdout } = await runCli(store, ["persona", "--json"]);
	assert.equal(code, 0);
	const payload = JSON.parse(stdout) as {
		result?: { persona?: string; context?: string; soul?: string };
	};
	const persona = payload.result?.persona ?? "";
	assert.match(persona, /#\s+Samantha/);
	assert.match(persona, /## Her CONTEXT\.md/);
	assert.match(persona, /## Her SOUL\.md/);
	assert.equal((persona.match(/## Her CONTEXT\.md/g) ?? []).length, 1);
	assert.ok((payload.result?.context ?? "").length > 0);
	assert.ok((payload.result?.soul ?? "").length > 0);
});

test("persona --json is a pure read (stable across repeated runs)", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-persona-"));
	await initStore(store);
	const first = await runCli(store, ["persona", "--json"]);
	const second = await runCli(store, ["persona", "--json"]);
	assert.equal(first.code, 0);
	assert.equal(second.code, 0);
	assert.equal(first.stdout, second.stdout);
});

// Regression lock: samantha-ui readPersona() runs `her persona --json` and reads
// payload.result.persona. Taking this name for another command silently drops
// the Studio personality layer. Fail if anyone steals the name again.
test("her persona --json keeps readPersona() payload shape (regression lock)", async () => {
	const store = await mkdtemp(join(tmpdir(), "her-persona-lock-"));
	await initStore(store);
	const { code, stdout } = await runCli(store, ["persona", "--json"]);
	assert.equal(code, 0);
	const payload = JSON.parse(stdout) as { result?: { persona?: unknown } };
	assert.equal(typeof payload.result?.persona, "string");
	const persona = payload.result?.persona as string;
	assert.ok(persona.length > 0, "result.persona must be a non-empty string");
	assert.match(persona, /You are Samantha\. You grew from Fei's memory/);
});
