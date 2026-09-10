import assert from "node:assert/strict";
import test from "node:test";
import {
	type DesignVersion,
	designPaths,
	type GitRun,
	listVersions,
	NOTES_REF,
	parseVersionLog,
	restoreDesign,
	stillPath,
	uncommittedFiles,
	validateDesignSlug,
} from "../src/her-core/design-version.ts";

const RS = "\u001e";
const FS = "\u001f";

/** A git that answers from a script and remembers what it was asked. */
function fakeGit(answers: Record<string, string | Error>): {
	run: GitRun;
	calls: string[][];
} {
	const calls: string[][] = [];
	const run: GitRun = async (_cwd, args) => {
		calls.push([...args]);
		const verb = args[0] ?? "";
		const key = verb === "log" && args.includes("--no-walk") ? "notes" : verb;
		const answer = answers[key];
		if (answer instanceof Error) throw answer;
		return answer ?? "";
	};
	return { run, calls };
}

function logLine(commit: string, at: string, subject: string, files: string[]): string {
	return `${RS}${commit}${FS}${at}${FS}${subject}\n${files.join("\n")}\n`;
}

test("a design is its screen and its notes, and never its manifest", () => {
	const paths = designPaths("loora-landing");
	assert.deepEqual(paths, ["packages/design-lab/src/screens/loora-landing", "design/projects/loora-landing"]);
	// The manifest is the record OF the history. Restoring it would erase the
	// entry that says a restore happened, which is the line you most want after.
	assert.ok(!paths.some((p) => p.endsWith(".project.json")));
});

test("a slug that could climb out of the repo is refused", () => {
	for (const bad of ["../etc", "a/b", "Loora", "loora_landing", "", "-x", "x-"]) {
		assert.throws(() => validateDesignSlug(bad), /Invalid design slug/, bad);
	}
	assert.doesNotThrow(() => validateDesignSlug("loora-landing-2"));
	assert.equal(stillPath("mosaic"), "design/stills/mosaic-top.png");
});

test("the log parser keeps subjects, dates and file lists together", () => {
	const stdout =
		logLine("a".repeat(40), "2026-09-09T12:00:00+08:00", "fix: tighten the ladder", [
			"packages/design-lab/src/screens/loora-landing/screen.tsx",
			"design/projects/loora-landing/filing.md",
		]) +
		logLine("b".repeat(40), "2026-09-08T09:30:00+08:00", "feat: first pass", [
			"packages/design-lab/src/screens/loora-landing/canvas.tsx",
		]);
	const versions = parseVersionLog(stdout);
	assert.equal(versions.length, 2);
	assert.equal(versions[0]?.subject, "fix: tighten the ladder");
	assert.equal(versions[0]?.at, "2026-09-09T12:00:00+08:00");
	assert.equal(versions[0]?.files.length, 2);
	assert.equal(versions[1]?.commit, "b".repeat(40));
	assert.equal(versions[1]?.name, null);
});

test("a subject with a newline in it does not become two versions", () => {
	// The separators are 0x1e / 0x1f precisely because a commit subject is
	// whatever a person typed. Splitting on newlines would invent a version.
	const stdout = `${RS}${"c".repeat(40)}${FS}2026-09-09T12:00:00Z${FS}fix: a subject\nthat wrapped\npackages/design-lab/src/screens/x/screen.tsx\n`;
	const versions = parseVersionLog(stdout);
	assert.equal(versions.length, 1);
	assert.equal(versions[0]?.subject, "fix: a subject");
});

test("an empty log is no versions, not a crash", () => {
	assert.deepEqual(parseVersionLog(""), []);
	assert.deepEqual(parseVersionLog("\n\n"), []);
});

test("listVersions asks git for this design's paths, and clamps the limit", async () => {
	const { run, calls } = fakeGit({
		log: logLine("a".repeat(40), "2026-09-09T12:00:00Z", "one", []),
	});
	await listVersions("mosaic", "/repo", { limit: 9999, run });
	const args = calls[0] ?? [];
	assert.equal(args[0], "log");
	assert.ok(args.includes("--max-count=200"), `clamped: ${args.join(" ")}`);
	assert.ok(args.includes("packages/design-lab/src/screens/mosaic"));
	assert.ok(args.includes("design/projects/mosaic"));
});

test("the display names G-434 wrote are read back onto the versions", async () => {
	// One system with two halves, not two systems: `design_version_name` hangs
	// the name on refs/notes/her-design and this is where it comes back.
	const sha = "a".repeat(40);
	const other = "b".repeat(40);
	const { run, calls } = fakeGit({
		log: logLine(sha, "2026-09-09T12:00:00Z", "one", []) + logLine(other, "2026-09-08T12:00:00Z", "two", []),
		notes: `${RS}${sha}${FS}three columns + generous whitespace\n${RS}${other}${FS}\n`,
	});
	const versions = await listVersions("mosaic", "/repo", { run });
	assert.equal(versions[0]?.name, "three columns + generous whitespace");
	assert.equal(versions[1]?.name, null);
	const notesCall = calls.find((c) => c.includes("--no-walk")) ?? [];
	assert.ok(notesCall.includes(`--notes=${NOTES_REF}`));
});

test("a repo with no notes ref still lists its versions", async () => {
	// Unnamed is the normal case. Failing the whole listing over a missing
	// notes ref would make the feature useless in every fresh checkout.
	const { run } = fakeGit({
		log: logLine("a".repeat(40), "2026-09-09T12:00:00Z", "one", []),
		notes: new Error("fatal: no notes found"),
	});
	const versions = await listVersions("mosaic", "/repo", { run });
	assert.equal(versions.length, 1);
	assert.equal(versions[0]?.name, null);
});

test("uncommitted files come back without git's status prefix", async () => {
	const { run } = fakeGit({
		status: " M packages/design-lab/src/screens/mosaic/screen.tsx\n?? design/projects/mosaic/notes.md\n",
	});
	assert.deepEqual(await uncommittedFiles("mosaic", "/repo", { run }), [
		"packages/design-lab/src/screens/mosaic/screen.tsx",
		"design/projects/mosaic/notes.md",
	]);
});

test("a dry run reports the files and writes nothing", async () => {
	const { run, calls } = fakeGit({
		diff: "packages/design-lab/src/screens/mosaic/screen.tsx\n",
	});
	const plan = await restoreDesign("mosaic", "abc1234", "/repo", { run });
	assert.equal(plan.applied, false);
	assert.deepEqual(plan.files, ["packages/design-lab/src/screens/mosaic/screen.tsx"]);
	assert.ok(!calls.some((c) => c[0] === "checkout"), "dry run must not check anything out");
});

test("applying checks out that commit, and only this design's paths", async () => {
	const { run, calls } = fakeGit({
		diff: "packages/design-lab/src/screens/mosaic/screen.tsx\n",
	});
	const plan = await restoreDesign("mosaic", "abc1234", "/repo", { apply: true, run });
	assert.equal(plan.applied, true);
	const checkout = calls.find((c) => c[0] === "checkout") ?? [];
	assert.deepEqual(checkout, [
		"checkout",
		"abc1234",
		"--",
		"packages/design-lab/src/screens/mosaic",
		"design/projects/mosaic",
	]);
	// HEAD is not moved. That is the whole reason this is allowed to exist
	// where design_version_list refuses to restore.
	assert.ok(!calls.some((c) => c[0] === "switch" || c[0] === "reset"));
});

test("a version that changes nothing is not written", async () => {
	const { run, calls } = fakeGit({ diff: "\n" });
	const plan = await restoreDesign("mosaic", "abc1234", "/repo", { apply: true, run });
	assert.deepEqual(plan.files, []);
	assert.equal(plan.applied, false);
	assert.ok(!calls.some((c) => c[0] === "checkout"));
});

test("anything that is not a sha is refused before git is called", async () => {
	const { run, calls } = fakeGit({});
	for (const bad of ["HEAD", "main", "abc123", "; rm -rf /", "abc1234; echo"]) {
		await assert.rejects(() => restoreDesign("mosaic", bad, "/repo", { apply: true, run }), /Invalid commit/, bad);
	}
	assert.equal(calls.length, 0);
});

test("a restore cannot be aimed outside the design", async () => {
	const { run } = fakeGit({ diff: "" });
	await assert.rejects(
		() => restoreDesign("../../etc", "abc1234", "/repo", { apply: true, run }),
		/Invalid design slug/,
	);
});

test("versions carry the fields the ledger stamps onto a round", () => {
	// design_project_set_stage(iterations, note) records commit + still so a
	// round in the ledger points at the version it produced. The shape those
	// come from is this one.
	const versions: DesignVersion[] = parseVersionLog(logLine("d".repeat(40), "2026-09-09T12:00:00Z", "round", []));
	const v = versions[0];
	assert.ok(v);
	assert.equal(typeof v.commit, "string");
	assert.equal(v.commit.length, 40);
});
