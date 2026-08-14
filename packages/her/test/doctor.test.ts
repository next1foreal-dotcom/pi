import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { runDoctor } from "../src/her-core/doctor.ts";
import { frontmatter, initStore, writeJson, writeText } from "../src/her-core/index.ts";

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-doctor-"));
	await initStore(root);
	return root;
}

async function raw(
	root: string,
	timestamp = new Date().toISOString().slice(0, 16),
	id = "session-1",
	body = "captured",
): Promise<void> {
	const stem = timestamp.replace(/:/g, "_");
	await writeText(
		join(root, "episodic", "raw", `${stem}--${id}.md`),
		`${frontmatter({ id, timestamp, project: "test", session_id: id })}${body}\n`,
	);
}

async function withStore(fn: (root: string) => Promise<void>): Promise<void> {
	const root = await tempStore();
	try {
		await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function snapshot(root: string): Promise<Record<string, string>> {
	const files: string[] = [];
	async function visit(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	await visit(root);
	const output: Record<string, string> = {};
	for (const path of files.sort()) {
		const bytes = await readFile(path);
		output[relative(root, path).split(sep).join("/")] = createHash("sha256").update(bytes).digest("hex");
	}
	return output;
}

test("runDoctor returns execution error for a missing root", async () => {
	const root = join(await mkdtemp(join(tmpdir(), "her-doctor-red-")), "missing");
	try {
		const report = await runDoctor(root);
		assert.equal(report.exitCode, 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("healthy store passes all eight checks", async () => {
	await withStore(async (root) => {
		await raw(root);
		const report = await runDoctor(root);
		assert.equal(report.exitCode, 0);
		assert.equal(report.checks.length, 8);
		assert.ok(report.checks.every((check) => check.status === "pass"));
		assert.equal(report.checks.at(-1)?.id, "DR-08");
	});
});

test("DR-08 fails on a start-without-end past the timeout and stays quiet in-flight", async () => {
	await withStore(async (root) => {
		await raw(root);
		const missing = await runDoctor(root, { checks: ["DR-08"] });
		assert.equal(missing.checks[0].status, "pass");
		assert.match(missing.checks[0].detail, /0 orphans/);
		const now = Date.now();
		const staleTs = new Date(now - 2 * 60 * 60 * 1000).toISOString();
		const freshTs = new Date(now - 30 * 1000).toISOString();
		await writeText(
			join(root, "audit", "ops.jsonl"),
			[
				JSON.stringify({ op: "synthesize", opId: "old-open", phase: "start", ts: staleTs }),
				JSON.stringify({ op: "consolidate", opId: "closed", phase: "start", ts: staleTs }),
				JSON.stringify({ op: "consolidate", opId: "closed", phase: "end", ts: staleTs, ok: true }),
				JSON.stringify({ op: "reingest", opId: "in-flight", phase: "start", ts: freshTs }),
				"",
			].join("\n"),
		);
		const report = await runDoctor(root, { checks: ["DR-08"] });
		assert.equal(report.exitCode, 1);
		assert.equal(report.checks[0].status, "fail");
		assert.match(report.checks[0].detail, /old-open/);
		assert.doesNotMatch(report.checks[0].detail, /in-flight/);
		assert.doesNotMatch(report.checks[0].detail, /closed/);
	});
});

test("doctor is byte-for-byte read only across a complete run", async () => {
	await withStore(async (root) => {
		await raw(root);
		const before = await snapshot(root);
		await runDoctor(root);
		assert.deepEqual(await snapshot(root), before);
	});
});

test("DR-01 rejects stale, empty, and malformed raw episode sets", async () => {
	await withStore(async (root) => {
		const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString().slice(0, 16);
		await raw(root, old, "old");
		const stale = await runDoctor(root, { checks: ["DR-01"] });
		assert.equal(stale.checks[0].status, "fail");
		await writeFile(join(root, "episodic", "raw", `${old.replace(/:/g, "_")}--old.md`), "", "utf8");
		const empty = await tempStore();
		try {
			const noEpisodes = await runDoctor(empty, { checks: ["DR-01"] });
			assert.equal(noEpisodes.checks[0].status, "fail");
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
		await rm(join(root, "episodic", "raw", `${old.replace(/:/g, "_")}--old.md`), { force: true });
		await writeText(join(root, "episodic", "raw", "not-a-timestamp.md"), "bad\n");
		const malformed = await runDoctor(root, { checks: ["DR-01"] });
		assert.equal(malformed.checks[0].status, "fail");
		assert.match(malformed.checks[0].detail, /unparsed=1/);
	});
});

test("DR-02 accepts null, string, and dict cursor shapes", async () => {
	await withStore(async (root) => {
		const timestamp = new Date().toISOString().slice(0, 16);
		await raw(root, timestamp, "cursor-session");
		for (const cursor of [null, "2000-01-01T00:00", { ts: timestamp, done_ids: ["cursor-session"] }]) {
			await writeJson(join(root, ".her", "state.json"), { cursor });
			const report = await runDoctor(root, { checks: ["DR-02"] });
			assert.equal(report.checks[0].status, "pass", JSON.stringify(cursor));
		}
	});
});

test("DR-02 fails loudly for garbage and future cursors", async () => {
	await withStore(async (root) => {
		const timestamp = new Date().toISOString().slice(0, 16);
		await raw(root, timestamp, "cursor-session");
		for (const cursor of [42, ["2026-01-01"], { ts: timestamp, done_ids: [42] }]) {
			await writeJson(join(root, ".her", "state.json"), { cursor });
			const report = await runDoctor(root, { checks: ["DR-02"] });
			assert.equal(report.checks[0].status, "fail", JSON.stringify(cursor));
		}
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 16);
		await writeJson(join(root, ".her", "state.json"), { cursor: future });
		const report = await runDoctor(root, { checks: ["DR-02"] });
		assert.equal(report.checks[0].status, "fail");
		assert.match(report.checks[0].detail, /later than newest/);
	});
});

test("DR-03 enforces raw minimum keys and allows unknown keys", async () => {
	await withStore(async (root) => {
		const timestamp = new Date().toISOString().slice(0, 16);
		await writeText(
			join(root, "episodic", "raw", `${timestamp.replace(/:/g, "_")}--missing-session.md`),
			`${frontmatter({ id: "missing-session", timestamp, project: "test", extra_key: "forward-compatible" })}body\\n`,
		);
		const missing = await runDoctor(root, { checks: ["DR-03"] });
		assert.equal(missing.checks[0].status, "fail");
		assert.match(missing.checks[0].detail, /episodic\/raw\/.*:session_id/);
		await writeText(
			join(root, "episodic", "raw", `${timestamp.replace(/:/g, "_")}--valid.md`),
			`${frontmatter({ id: "valid", timestamp, project: "test", session_id: "valid", future_key: "ok" })}body\\n`,
		);
		await rm(join(root, "episodic", "raw", `${timestamp.replace(/:/g, "_")}--missing-session.md`));
		const valid = await runDoctor(root, { checks: ["DR-03"] });
		assert.equal(valid.checks[0].status, "pass");
	});
});

test("DR-03 skips world/_snapshots and accepts legacy topics that have updated", async () => {
	await withStore(async (root) => {
		await writeText(
			join(root, "world", "_snapshots", "luka-a66892ce", "original.md"),
			"snapshot body with no frontmatter\n",
		);
		await writeText(
			join(root, "topics", "legacy.md"),
			`${frontmatter({ theme: "legacy", updated: "2026-06-01", members: ["a"] })}body\n`,
		);
		const skipped = await runDoctor(root, { checks: ["DR-03"] });
		assert.equal(skipped.checks[0].status, "pass", skipped.checks[0].detail);
		assert.doesNotMatch(skipped.checks[0].detail, /_snapshots/);

		await writeText(join(root, "episodic", "raw", "2026-08-05T1422--no-fm.md"), "bulk export without a fence\n");
		const stillMissing = await runDoctor(root, { checks: ["DR-03"] });
		assert.equal(stillMissing.checks[0].status, "fail");
		assert.equal(stillMissing.checks[0].counts?.missing, 4, stillMissing.checks[0].detail);
		assert.match(stillMissing.checks[0].detail, /episodic\/raw\/.*:id/);
	});
});

test("DR-01/DR-02 count all three raw filename generations", async () => {
	await withStore(async (root) => {
		const rawDir = join(root, "episodic", "raw");
		const day = new Date().toISOString().slice(0, 10);
		const body = (id: string) =>
			`${frontmatter({ id, timestamp: `${day}T00:00`, project: "p", session_id: id })}text\n`;
		// current: THH_MM · legacy compact: THHMM · bulk export: date only
		await writeText(join(rawDir, `${day}T09_15--current.md`), body("current"));
		await writeText(join(rawDir, `${day}T0915--legacy.md`), body("legacy"));
		await writeText(join(rawDir, `${day}--FULL-SESSION-export--bulk.md`), body("bulk"));

		const report = await runDoctor(root, { checks: ["DR-01"] });
		assert.equal(report.checks[0].counts?.parsed, 3, report.checks[0].detail);
		assert.equal(report.checks[0].counts?.unparsed, 0);
	});
});

test("DR-02 surfaces unparsed episodes so the lag is not read as the whole truth", async () => {
	await withStore(async (root) => {
		const rawDir = join(root, "episodic", "raw");
		const day = new Date().toISOString().slice(0, 10);
		await writeText(
			join(rawDir, `${day}T09_15--seen.md`),
			`${frontmatter({ id: "seen", timestamp: `${day}T09:15`, project: "p", session_id: "seen" })}text\n`,
		);
		await writeText(join(rawDir, "totally-unparseable.md"), "no timestamp anywhere\n");
		await writeJson(join(root, ".her", "state.json"), { cursor: { ts: `${day}T09:00`, done_ids: [] } });

		const report = await runDoctor(root, { checks: ["DR-02"] });
		// The lag number alone would understate the backlog; the detail must say so.
		assert.match(report.checks[0].detail, /unparsed=1/);
		assert.equal(report.checks[0].counts?.unparsed, 1);
	});
});

test("DR-04 reports unresolved wikilinks as WARN by default", async () => {
	await withStore(async (root) => {
		await writeText(
			join(root, "semantic", "links.md"),
			`${frontmatter({ id: "links", type: "note", created: "2026-08-11" })}See [[does-not-exist]].\n`,
		);
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.exitCode, 0);
		assert.equal(report.checks[0].status, "warn");
		assert.equal(report.checks[0].counts?.unresolved, 1);
		assert.match(report.checks[0].detail, /does-not-exist/);
	});
});

test("DR-04 ignores bracket syntax inside raw transcripts but keeps them as targets", async () => {
	await withStore(async (root) => {
		// A verbatim transcript full of POSIX/spread bracket syntax must produce
		// zero unresolved links — before the raw exclusion this alone drowned the
		// real store in ~9000 false positives.
		await writeText(
			join(root, "episodic", "raw", "2026-08-11T10_00--transcript.md"),
			`${frontmatter({ id: "t1", timestamp: "2026-08-11T10:00", project: "p", session_id: "s" })}grep '[[:space:]]' and const [[...path]] = x\n`,
		);
		// Curated notes cite episodes by session id (the store's own convention);
		// both the id form and the full-path form must resolve to that raw file.
		await writeText(
			join(root, "semantic", "pointer.md"),
			`${frontmatter({ id: "pointer", type: "note", created: "2026-08-11" })}See [[episodic/raw/transcript]] and [[episodic/raw/2026-08-11T10_00--transcript]].\n`,
		);
		// The context log is append-only history — dead links inside it are frozen
		// and must not be reported.
		await writeText(join(root, "narrative", "context-log.md"), "history: [[semantic/renamed-away]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "pass", report.checks[0].detail);
		assert.equal(report.checks[0].counts?.unresolved, 0);
	});
});

test("DR-04 resolves a bare slug against any note dir, not a hardcoded four", async () => {
	await withStore(async (root) => {
		// narrative/ was not in the original four-directory list, so real links like
		// INDEX.md -> [[CONTEXT]] were reported broken.
		await writeText(join(root, "narrative", "CONTEXT.md"), "the narrative\n");
		await writeText(join(root, "INDEX.md"), "see [[CONTEXT]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "pass", report.checks[0].detail);
	});
});

test("DR-04 ignores generated eval reports that quote dead links", async () => {
	await withStore(async (root) => {
		// evals/lint.md is runMemoryLint's own output; the dead links it quotes are
		// its findings, not new ones.
		await writeText(join(root, "evals", "lint.md"), "broken: [[gone-from-store]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "pass", report.checks[0].detail);
	});
});

test("DR-04 still reports a slug that exists nowhere", async () => {
	await withStore(async (root) => {
		await writeText(join(root, "INDEX.md"), "see [[nothing-named-this]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "warn");
		assert.match(report.checks[0].detail, /nothing-named-this/);
	});
});

test("DR-04 still reports a dead episode citation from a curated note", async () => {
	await withStore(async (root) => {
		await writeText(
			join(root, "semantic", "dangling.md"),
			`${frontmatter({ id: "dangling", type: "note", created: "2026-08-11" })}See [[episodic/raw/never-captured]].\n`,
		);
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "warn");
		assert.equal(report.checks[0].counts?.unresolved, 1);
		assert.match(report.checks[0].detail, /never-captured/);
	});
});

test("DR-05 finds world secrets without echoing secret text", async () => {
	await withStore(async (root) => {
		const secret = "sk-" + "123456789012345678901234";
		await writeText(
			join(root, "world", "leak.md"),
			`${frontmatter({ id: "leak", title: "Leak", source_url: "https://example.test", source_type: "web", captured_at: "2026-08-11", content_hash: "hash" })}body with ${secret}\n`,
		);
		const report = await runDoctor(root, { checks: ["DR-05"] });
		assert.equal(report.checks[0].status, "fail");
		assert.equal(report.checks[0].counts?.hits, 1);
		assert.doesNotMatch(report.checks[0].detail, new RegExp(secret));
		assert.match(report.checks[0].detail, /world\/leak\.md:\d+/);
	});
});

test("DR-05 counts $VAR references apart from real values", async () => {
	await withStore(async (root) => {
		const secret = "sk-" + "123456789012345678901234";
		const head = frontmatter({
			id: "n",
			title: "T",
			source_url: "https://example.test",
			source_type: "web",
			captured_at: "2026-08-11",
			content_hash: "h",
		});
		// A config example in an architecture doc is not a leak; counting it as one
		// trains the reader to ignore the check.
		await writeText(join(root, "world", "doc.md"), `${head}api_key: "$HER_LLM_API_KEY"\nBearer \${TOKEN}\n`);
		await writeText(join(root, "world", "leak.md"), `${head}body with ${secret}\n`);

		const report = await runDoctor(root, { checks: ["DR-05"] });
		assert.equal(report.checks[0].counts?.hits, 1, report.checks[0].detail);
		assert.equal(report.checks[0].counts?.placeholders, 2, report.checks[0].detail);
		assert.match(report.checks[0].detail, /placeholder/i);
		// Placeholder-only stores must not fail the check.
		assert.match(report.checks[0].detail, /world\/leak\.md:\d+/);
		assert.doesNotMatch(report.checks[0].detail, /world\/doc\.md/);
	});
});

test("DR-04 groups findings by target so the output is a worklist", async () => {
	await withStore(async (root) => {
		await writeText(join(root, "semantic", "a.md"), "see [[missing-note]]\n");
		await writeText(join(root, "semantic", "b.md"), "also [[missing-note]]\n");
		await writeText(join(root, "semantic", "c.md"), "and [[other-gone]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].counts?.unresolved, 3);
		assert.equal(report.checks[0].counts?.targets, 2);
		// The most-referenced dead target leads, with its reference count.
		assert.match(report.checks[0].detail, /\[\[missing-note\]\] ×2/);
		assert.match(report.checks[0].detail, /\[\[other-gone\]\]/);
	});
});

test("DR-04 ignores wikilinks inside ingested world notes", async () => {
	await withStore(async (root) => {
		// world/ bodies are somebody else's article; their links point at their vault.
		await writeText(join(root, "world", "article.md"), "author wrote [[their-own-note]]\n");
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.checks[0].status, "pass", report.checks[0].detail);
	});
});

test("DR-06 distinguishes fresh and stale locks", async () => {
	await withStore(async (root) => {
		const lock = join(root, ".her", "lock");
		await writeText(lock, "held\n");
		const fresh = new Date(Date.now() - 60_000);
		await utimes(lock, fresh, fresh);
		assert.equal((await runDoctor(root, { checks: ["DR-06"] })).checks[0].status, "pass");
		const stale = new Date(Date.now() - 40 * 60_000);
		await utimes(lock, stale, stale);
		const report = await runDoctor(root, { checks: ["DR-06"] });
		assert.equal(report.checks[0].status, "fail");
	});
});

test("DR-07 rejects invalid state JSON and invalid config syntax", async () => {
	await withStore(async (root) => {
		await writeText(join(root, ".her", "state.json"), "{not-json\n");
		const stateReport = await runDoctor(root, { checks: ["DR-07"] });
		assert.equal(stateReport.checks[0].status, "fail");
		assert.match(stateReport.checks[0].detail, /state\.json invalid/);
		await writeJson(join(root, ".her", "state.json"), { cursor: null });
		await writeText(join(root, ".her", "config.yaml"), "doctor:\n  links_severity: maybe\n");
		const configReport = await runDoctor(root, { checks: ["DR-07"] });
		assert.equal(configReport.checks[0].status, "fail");
		assert.match(configReport.checks[0].detail, /links_severity/);
	});
});

test("strict mode turns a warning into a failing exit", async () => {
	await withStore(async (root) => {
		await writeText(
			join(root, "semantic", "links.md"),
			`${frontmatter({ id: "links", type: "note", created: "2026-08-11" })}[[gone]].\n`,
		);
		const report = await runDoctor(root, { checks: ["DR-04"], strict: true });
		assert.equal(report.exitCode, 1);
		assert.equal(report.checks[0].status, "fail");
	});
});

test("CLI registers doctor with root, JSON output, and exit code", async () => {
	await withStore(async (root) => {
		await raw(root);
		const stdout: string[] = [];
		const stderr: string[] = [];
		const stream = (target: string[]): NodeJS.WritableStream =>
			({
				write(chunk: string | Uint8Array): boolean {
					target.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
					return true;
				},
			}) as unknown as NodeJS.WritableStream;
		const { runHerCli } = await import("../src/cli.ts");
		const code = await runHerCli(["doctor", "--root", root, "--json"], {}, process.cwd(), {
			stdout: stream(stdout),
			stderr: stream(stderr),
		});
		assert.equal(code, 0, stderr.join(""));
		assert.equal(stderr.length, 0);
		const checks = JSON.parse(stdout.join("")) as Array<{ id: string; severity: string; status: string }>;
		assert.equal(checks.length, 8);
		assert.equal(checks[0].id, "DR-01");
		assert.equal(checks[0].severity, "fail");
		assert.equal(checks[0].status, "pass");
		const selected: string[] = [];
		const selectedCode = await runHerCli(
			["doctor", "--root", root, "--check", "DR-01", "DR-02", "--json"],
			{},
			process.cwd(),
			{
				stdout: stream(selected),
				stderr: stream([]),
			},
		);
		assert.equal(selectedCode, 0);
		assert.equal((JSON.parse(selected.join("")) as Array<{ id: string }>).length, 2);
	});
});

test("doctor config overrides link severity and line allowlist", async () => {
	await withStore(async (root) => {
		await writeText(
			join(root, "semantic", "links.md"),
			`${frontmatter({ id: "links", type: "note", created: "2026-08-11" })}[[gone]].\n`,
		);
		await writeText(
			join(root, ".her", "config.yaml"),
			"doctor:\n  links_severity: fail\n  secrets_allow_lines:\n    - allowed-example\n",
		);
		const report = await runDoctor(root, { checks: ["DR-04"] });
		assert.equal(report.exitCode, 1);
		assert.equal(report.checks[0].severity, "fail");
		assert.equal(report.checks[0].status, "fail");
	});
});
