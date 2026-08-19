import assert from "node:assert/strict";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import { appendSelfmodSnapshot } from "../src/her-core/selfmod-ledger.ts";
import { acquireSelfmodLock } from "../src/her-core/selfmod-lock.ts";
import { runSelfmodPickup } from "../src/her-core/selfmod-pickup.ts";
import {
	runSkillsDrift,
	SKILLS_DRIFT_PATHS_BEGIN,
	SKILLS_DRIFT_PATHS_END,
	skillsDriftLedgerPath,
	skillsDriftStatePath,
} from "../src/her-core/skills-drift.ts";
import { readText } from "../src/her-core/store.ts";
import { destroyFixture, git, makeFixture, proposalFor, SKILL_REL, writeRel } from "./selfmod-harness.ts";

const VENDOR_REL = "packages/her/pi-package/skills/vendor-example/SKILL.md";
const T0 = new Date("2026-08-18T12:00:00.000Z");
const T_PLUS_30M = new Date("2026-08-18T12:30:00.000Z");
const T_PLUS_24H = new Date("2026-08-19T12:00:00.000Z");

interface CliResult {
	code: number;
	stderr: string;
	stdout: string;
}

async function runCli(args: string[], memoryDir: string, cwd: string): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	const io = {
		stderr: {
			write(chunk: string) {
				stderr += chunk;
				return true;
			},
		},
		stdout: {
			write(chunk: string) {
				stdout += chunk;
				return true;
			},
		},
	};
	const code = await runHerCli(args, { ...process.env, HER_MEMORY_DIR: memoryDir }, cwd, io as never);
	return { code, stderr, stdout };
}

async function dirtyOwned(repoRoot: string): Promise<void> {
	await writeRel(repoRoot, SKILL_REL, "# fixture\nhello\n# dirty owned\n");
}

async function dirtyVendored(repoRoot: string): Promise<void> {
	await writeRel(repoRoot, VENDOR_REL, "# vendored\n");
}

function driftNotices(notices: string[]): string[] {
	return notices.filter((text) => /skills-drift/i.test(text));
}

test("dirty owned skill is ALARM with one ledger line and one TG; same set is deduped; 24h resends", async () => {
	const fx = await makeFixture("sd-alarm");
	try {
		await dirtyOwned(fx.repoRoot);
		const notices: string[] = [];
		const sendNotify = async (text: string) => {
			notices.push(text);
		};
		const first = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T0,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify,
		});
		assert.ok(first.unattributed.some((path) => path.replace(/\\/g, "/").endsWith("her-intake/SKILL.md")));
		assert.equal(
			first.unattributed.every((path) => !path.includes("vendor-example")),
			true,
		);
		assert.equal(first.telegramSent, true);
		assert.equal(driftNotices(notices).length, 1);
		const tg = driftNotices(notices)[0];
		assert.ok(tg.includes(SKILLS_DRIFT_PATHS_BEGIN));
		assert.ok(tg.includes(SKILLS_DRIFT_PATHS_END));
		assert.ok(!tg.includes("@@"));
		assert.ok(!/\n\+[^+]/.test(tg));
		const ledger1 = await readText(skillsDriftLedgerPath(fx.memoryDir));
		assert.ok(ledger1?.includes("unattributed"));
		assert.ok(await readText(skillsDriftStatePath(fx.memoryDir)));

		const second = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T_PLUS_30M,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify,
		});
		assert.ok(second.unattributed.length > 0);
		assert.equal(second.telegramSent, false);
		assert.equal(driftNotices(notices).length, 1);

		const third = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T_PLUS_24H,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify,
		});
		assert.ok(third.unattributed.length > 0);
		assert.equal(third.telegramSent, true);
		assert.equal(driftNotices(notices).length, 2);
	} finally {
		await destroyFixture(fx);
	}
});

test("dirty owned skill is silent while the selfmod lock is held", async () => {
	const fx = await makeFixture("sd-lock");
	try {
		await dirtyOwned(fx.repoRoot);
		const lock = await acquireSelfmodLock({ memoryDir: fx.memoryDir, now: T0, reason: "pipeline" });
		assert.equal(lock.acquired, true);
		const notices: string[] = [];
		const report = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T0,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
		});
		assert.deepEqual(report.unattributed, []);
		assert.equal(report.telegramSent, false);
		assert.equal(driftNotices(notices).length, 0);
	} finally {
		await destroyFixture(fx);
	}
});

test("vendored skill dirt does not ALARM", async () => {
	const fx = await makeFixture("sd-vendor");
	try {
		await dirtyVendored(fx.repoRoot);
		const notices: string[] = [];
		const report = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T0,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
		});
		assert.deepEqual(report.unattributed, []);
		assert.equal(report.telegramSent, false);
		assert.equal(driftNotices(notices).length, 0);
		assert.ok(!report.human.some((row) => row.subject.includes("vendor-example")));
	} finally {
		await destroyFixture(fx);
	}
});

test("committed owned skill with no tag and no ledger is INFO and does not TG", async () => {
	const fx = await makeFixture("sd-info");
	try {
		await writeRel(fx.repoRoot, SKILL_REL, "# fixture\nhello\n# committed human\n");
		await git(fx.repoRoot, "add", SKILL_REL);
		await git(fx.repoRoot, "commit", "-q", "-m", "human skill edit");
		const head = (await git(fx.repoRoot, "rev-parse", "HEAD")).stdout.trim();
		const notices: string[] = [];
		const report = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T0,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
		});
		assert.deepEqual(report.unattributed, []);
		assert.equal(report.telegramSent, false);
		assert.equal(driftNotices(notices).length, 0);
		const hit = report.human.find((row) => row.hash === head);
		assert.ok(hit);
		assert.equal(hit.kind, "human");
		assert.equal(hit.subject, "human skill edit");
		assert.ok(hit.author.length > 0);
		assert.ok(hit.date.length > 0);
		assert.equal(
			report.selfmod.some((row) => row.hash === head),
			false,
		);
	} finally {
		await destroyFixture(fx);
	}
});

test("committed hash listed as mergeCommit is classified selfmod and not reported", async () => {
	const fx = await makeFixture("sd-selfmod");
	try {
		const head = (await git(fx.repoRoot, "rev-parse", "HEAD")).stdout.trim();
		await appendSelfmodSnapshot(
			fx.memoryDir,
			{
				proposal: proposalFor(fx),
				stage: "merge",
				mergeCommit: head,
				anchorCommit: head,
				updatedAt: "2026-08-18T00:00:00.000Z",
			},
			"gate",
		);
		const notices: string[] = [];
		const report = await runSkillsDrift({
			memoryDir: fx.memoryDir,
			now: T0,
			persist: true,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
		});
		assert.deepEqual(report.unattributed, []);
		assert.equal(report.telegramSent, false);
		assert.equal(
			report.human.some((row) => row.hash === head),
			false,
		);
		assert.ok(report.selfmod.some((row) => row.hash === head && row.kind === "selfmod"));
		assert.equal(driftNotices(notices).length, 0);
	} finally {
		await destroyFixture(fx);
	}
});

test("pickup still returns empty when the detector throws", async () => {
	const fx = await makeFixture("sd-throw");
	try {
		const result = await runSelfmodPickup({
			git: async () => {
				throw new Error("injected drift boom");
			},
			memoryDir: fx.memoryDir,
			now: T0,
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.action, "empty");
		assert.ok(result.driftError);
		assert.match(result.driftError, /injected drift boom/);
	} finally {
		await destroyFixture(fx);
	}
});

test("pickup tick persists ALARM and does not block empty action", async () => {
	const fx = await makeFixture("sd-hook");
	try {
		await dirtyOwned(fx.repoRoot);
		const notices: string[] = [];
		const result = await runSelfmodPickup({
			memoryDir: fx.memoryDir,
			now: T0,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.action, "empty");
		assert.equal(result.driftError, undefined);
		assert.ok(result.drift && result.drift.unattributed.length > 0);
		assert.equal(result.drift.telegramSent, true);
		assert.equal(driftNotices(notices).length, 1);
		const again = await runSelfmodPickup({
			memoryDir: fx.memoryDir,
			now: T_PLUS_30M,
			repoRoot: fx.repoRoot,
			sendNotify: async (text) => {
				notices.push(text);
			},
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(again.action, "empty");
		assert.equal(again.drift?.telegramSent, false);
		assert.equal(driftNotices(notices).length, 1);
	} finally {
		await destroyFixture(fx);
	}
});

test("CLI skills-drift --json is read-only and does not move the dedup clock", async () => {
	const fx = await makeFixture("sd-cli");
	try {
		await dirtyOwned(fx.repoRoot);
		const ran = await runCli(["skills-drift", "--json"], fx.memoryDir, fx.repoRoot);
		assert.equal(ran.code, 0, ran.stderr);
		const payload = JSON.parse(ran.stdout) as {
			telegramSent: boolean;
			unattributed: string[];
		};
		assert.ok(payload.unattributed.length > 0);
		assert.equal(payload.telegramSent, false);
		assert.equal(await readText(skillsDriftStatePath(fx.memoryDir)), undefined);
		assert.equal(await readText(skillsDriftLedgerPath(fx.memoryDir)), undefined);
		const help = await runCli(["help"], fx.memoryDir, fx.repoRoot);
		assert.match(help.stdout + help.stderr, /skills-drift/);
	} finally {
		await destroyFixture(fx);
	}
});
