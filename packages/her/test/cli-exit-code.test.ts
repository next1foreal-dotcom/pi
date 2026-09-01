import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const RAW = readFileSync(join(process.cwd(), "packages", "her", "src", "cli.ts"), "utf8");

/**
 * Comments are not code. The fix's own doc comment quotes the expression it
 * replaced, and counting that as a live site would make this test report a
 * violation that does not exist.
 */
const CLI = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * 2026-09-01 02:00: a consolidate batch digested its episodes, quarantined the
 * segments that would not fit, and exited 1 anyway — because every command
 * ended with `payload.status.status === "unknown" ? 1 : 0`, the git-sync probe
 * of her-memory. ops/scheduled/her-growth.ps1 breaks the run on a non-zero
 * batch, so one unreadable `git status` cost the remaining 29 batches and her
 * memory pipeline stalled for the day.
 *
 * The coupling existed at 47 sites, which is why consolidate, synthesize and
 * freshness-check were all failing at once. These guard the fix from being
 * re-introduced one command at a time.
 */
test("a command's exit code does not depend on the git-sync probe", () => {
	const coupled = CLI.match(/payload\.status\.status === "unknown"/g) ?? [];
	assert.equal(
		coupled.length,
		1,
		`the sync probe may decide the exit code of "her status" and nothing else; found ${coupled.length} site(s)`,
	);

	// And the one survivor must be inside the status command itself.
	const statusAt = CLI.indexOf('if (command.kind === "status") {');
	assert.ok(statusAt > 0, "the status command must still exist");
	const nextAt = CLI.indexOf('if (command.kind === "', statusAt + 10);
	const statusBlock = CLI.slice(statusAt, nextAt);
	assert.match(
		statusBlock,
		/payload\.status\.status === "unknown"/,
		"for `her status`, an unreadable state IS the answer",
	);
});

test("work commands report success through WORK_OK, and it is really zero", () => {
	assert.match(CLI, /const WORK_OK = 0;/);
	// A non-trivial number of commands must actually use it — a fix applied to
	// two examples and called done is how this bug survived the first time.
	const uses = CLI.match(/return WORK_OK;/g) ?? [];
	assert.ok(uses.length > 30, `expected the fix across the CLI, saw ${uses.length} use(s)`);

	// The placeholder used while patching must not have survived.
	assert.equal(/if \(false\)/.test(CLI), false, "no dead branches left behind");
});

test("commands with a real verdict keep it", () => {
	// dispatch and the golden evals decide their own exit code; the probe used
	// to return 1 BEFORE those lines could run.
	assert.match(CLI, /return result\.status === "completed" \? 0 : 1;/);
	assert.match(CLI, /return result\.status === "pass" \? 0 : 1;/);
});
