import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { appendEvent, eventHistoryPath } from "../src/her-core/event-history.ts";
import { appendSelfmodSnapshot, readSelfmodRecords, selfmodLedgerPath } from "../src/her-core/selfmod-ledger.ts";
import { acquireSelfmodLock, releaseSelfmodLock } from "../src/her-core/selfmod-lock.ts";
import { checkRollback } from "../src/her-core/selfmod-rollback.ts";
import type { SelfModRunRecord } from "../src/her-core/selfmod-types.ts";
import { applySkillLine, destroyFixture, git, makeFixture, proposalFor, SKILL_REL } from "./selfmod-harness.ts";

// Synthetic adoption and host observations in disposable real Git repositories.
const adoptedAt = "2026-10-01T10:00:00.000Z";
const observedAt = "2026-10-01T10:01:00.000Z";
const now = new Date("2026-10-01T10:02:00.000Z");
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const fx = await makeFixture("rollback-evidence");
	t.after(() => destroyFixture(fx));
	// Keep working bytes identical to Git blobs for the byte-for-byte restoration assertion.
	await git(fx.repoRoot, "config", "core.autocrlf", "false");
	const original = await readFile(join(fx.repoRoot, SKILL_REL));
	const anchorCommit = (await git(fx.repoRoot, "rev-parse", "HEAD")).stdout.trim();
	await applySkillLine(fx.repoRoot);
	const mergeCommit = (await git(fx.repoRoot, "rev-parse", "HEAD")).stdout.trim();
	await git(fx.repoRoot, "tag", `selfmod/${fx.id}`, mergeCommit);
	const record: SelfModRunRecord = {
		proposal: proposalFor(fx),
		stage: "merge",
		anchorCommit,
		mergeCommit,
		updatedAt: adoptedAt,
	};
	await appendSelfmodSnapshot(fx.memoryDir, record, "gate");
	const refs = { selfmod: { proposalId: fx.id, mergeCommit, targetPaths: [SKILL_REL] } };
	const event = {
		id: "observed-failure",
		kind: "organ.round.end",
		actor: "synthesize",
		ts: observedAt,
		data: { runId: "observed-run", ok: false, error: `failed ${fx.id} ${SKILL_REL}` },
		refs,
	};
	const check = (events: unknown[], injectedGit = git) =>
		checkRollback({
			...fx,
			now,
			git: injectedGit,
			readHistoryText: async () => events.map((e) => JSON.stringify(e)).join("\n"),
		});
	return { ...fx, original, record, refs, event, check };
}

for (const [name, change] of [
	["pre-adoption error", (e: Record<string, unknown>) => ({ ...e, ts: "2026-10-01T09:59:59.000Z" })],
	["future error", (e: Record<string, unknown>) => ({ ...e, ts: "2026-10-01T11:00:00.000Z" })],
	["invalid timestamp", (e: Record<string, unknown>) => ({ ...e, ts: "invalid" })],
	["free-text filename and proposal mention", (e: Record<string, unknown>) => ({ ...e, refs: undefined })],
	["derived crash claim", (e: Record<string, unknown>) => ({ ...e, derived: true })],
] as const) {
	test(`rollback refuses ${name}`, async (t) => {
		const f = await fixture(t);
		const result = await f.check([change(f.event)]);
		assert.notEqual(result.action, "reverted");
		assert.equal((await git(f.repoRoot, "rev-parse", "HEAD")).stdout.trim(), f.record.mergeCommit);
	});
}
for (const field of ["proposalId", "mergeCommit", "targetPaths"] as const) {
	test(`rollback requires exact structured ${field}`, async (t) => {
		const f = await fixture(t);
		const binding = {
			...f.refs.selfmod,
			[field]:
				field === "targetPaths"
					? [SKILL_REL.replace("her-intake", "her-design")]
					: field === "proposalId"
						? `${f.id}-other`
						: "f".repeat(40),
		};
		assert.notEqual((await f.check([{ ...f.event, refs: { selfmod: binding } }])).action, "reverted");
	});
}
test("a still-running unmatched start is pending evidence, never a crash", async (t) => {
	const f = await fixture(t);
	const start = { ...f.event, kind: "organ.round.start", data: { runId: f.id } };
	assert.equal((await f.check([start])).action, "needs-evidence");
	const rows = await readSelfmodRecords(f.memoryDir);
	assert.equal(rows.at(-1)?.stage, "merge");
	assert.equal(rows.length, 2);
	await f.check([start]);
	assert.equal((await readSelfmodRecords(f.memoryDir)).length, 2, "same pending observation is not re-appended");
});
test("planned restart suppresses a related failed host exit", async (t) => {
	const f = await fixture(t);
	const end = { ...f.event, kind: "host.run.end", data: { runId: f.id, ok: false, exitCode: 1 } };
	const planned = { ...end, id: "planned", kind: "host.restart_planned", ts: "2026-10-01T10:00:30.000Z" };
	assert.notEqual((await f.check([planned, end])).action, "reverted");
});
test("confirmed failed host exit with exact adoption binding can revert", async (t) => {
	const f = await fixture(t);
	assert.equal(
		(await f.check([{ ...f.event, kind: "host.run.end", data: { runId: f.id, ok: false, exitCode: 1 } }])).action,
		"reverted",
	);
});
test("actual revert restores exact bytes and only appends both audit histories", async (t) => {
	const f = await fixture(t);
	await appendEvent("organ.round.end", "synthesize", f.event.data, f.refs, f.memoryDir);
	const ledger = await readFile(selfmodLedgerPath(f.memoryDir), "utf8");
	const history = await readFile(eventHistoryPath(f.memoryDir), "utf8");
	const result = await f.check([f.event]);
	assert.equal(result.action, "reverted");
	assert.deepEqual(await readFile(join(f.repoRoot, SKILL_REL)), f.original);
	assert.ok((await readFile(selfmodLedgerPath(f.memoryDir), "utf8")).startsWith(ledger));
	assert.ok((await readFile(eventHistoryPath(f.memoryDir), "utf8")).startsWith(history));
	assert.equal((await f.check([f.event])).action, "noop");
	assert.equal((await git(f.repoRoot, "rev-parse", "HEAD")).stdout.trim(), result.record.rollback?.revertCommit);
});
test("concurrent rollback checks execute only one real revert", async (t) => {
	const f = await fixture(t);
	const results = await Promise.all([f.check([f.event]), f.check([f.event])]);
	assert.equal(results.filter((r) => r.action === "reverted").length, 1);
	assert.deepEqual(await readFile(join(f.repoRoot, SKILL_REL)), f.original);
});
test("rollback respects the shared adoption lock", async (t) => {
	const f = await fixture(t);
	await acquireSelfmodLock({ memoryDir: f.memoryDir, by: "adoption" });
	try {
		assert.equal((await f.check([f.event])).action, "busy");
	} finally {
		await releaseSelfmodLock(f.memoryDir);
	}
});
test("later target edits are preserved for manual review", async (t) => {
	const f = await fixture(t);
	await applySkillLine(f.repoRoot, "# later change");
	assert.equal((await f.check([f.event])).action, "needs-evidence");
	assert.match(await readFile(join(f.repoRoot, SKILL_REL), "utf8"), /later change/);
});
test("revert failure stays pending and is not retried automatically", async (t) => {
	const f = await fixture(t);
	let attempts = 0;
	const failingGit: typeof git = async (cwd, ...args) => {
		if (args[0] === "revert") {
			attempts++;
			throw new Error("revert conflict");
		}
		return git(cwd, ...args);
	};
	assert.equal((await f.check([f.event], failingGit)).action, "needs-evidence");
	assert.equal((await f.check([f.event], failingGit)).action, "needs-evidence");
	assert.equal(attempts, 1);
	assert.equal((await readSelfmodRecords(f.memoryDir)).at(-1)?.stage, "merge");
});
test("interruption after real revert does not cause a second revert", async (t) => {
	const f = await fixture(t);
	let reverted = false;
	const interruptedGit: typeof git = async (cwd, ...args) => {
		if (reverted) throw new Error("host interrupted after revert");
		const result = await git(cwd, ...args);
		if (args[0] === "revert") reverted = true;
		return result;
	};
	assert.equal((await f.check([f.event], interruptedGit)).action, "needs-evidence");
	assert.equal((await f.check([f.event])).action, "needs-evidence");
	assert.deepEqual(await readFile(join(f.repoRoot, SKILL_REL)), f.original);
});
test("pending observations do not renew the original watch window", async (t) => {
	const f = await fixture(t);
	await f.check([{ ...f.event, refs: undefined }]);
	const result = await checkRollback({
		...f,
		now: new Date("2026-10-02T10:02:00.000Z"),
		git,
		readHistoryText: async () => JSON.stringify(f.event),
	});
	assert.equal(result.action, "window-closed");
});
test("invalid adoption time is pending, not an unlimited watch window", async (t) => {
	const f = await fixture(t);
	const invalid = { ...f.record, proposal: { ...f.record.proposal, id: "invalid-adoption" }, updatedAt: "invalid" };
	await appendSelfmodSnapshot(f.memoryDir, invalid, "gate");
	assert.equal((await checkRollback({ ...f, id: invalid.proposal.id, now, git })).action, "needs-evidence");
});
test("actual Git conflict is recorded and preserved without automatic retry", async (t) => {
	const f = await fixture(t);
	let first = true;
	const conflictGit: typeof git = async (cwd, ...args) => {
		if (args[0] === "revert" && first) {
			first = false;
			// Simulate another writer after the precondition check.
			await applySkillLine(cwd, "# conflicting later edit");
		}
		return git(cwd, ...args);
	};
	const result = await f.check([f.event], conflictGit);
	assert.equal(result.action, "needs-evidence");
	assert.equal(result.record.rollbackCheck?.status, "failed");
	assert.match((await git(f.repoRoot, "status", "--porcelain")).stdout, /UU/);
	assert.equal((await f.check([f.event])).action, "needs-evidence");
});
