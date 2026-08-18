import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { runHerCli } from "../src/cli.ts";
import { readSelfmodRecords } from "../src/her-core/selfmod.ts";
import { destroyFixture, makeFixture, proposalFor } from "./selfmod-harness.ts";

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

test("CLI selfmod-run records an idea proposal and status dumps it", async () => {
	const fx = await makeFixture("cli");
	try {
		const proposalPath = join(fx.memoryDir, "proposal.json");
		await writeFile(
			proposalPath,
			`${JSON.stringify(proposalFor(fx, { motivation: { kind: "idea", evidenceRef: "" } }), null, 2)}\n`,
		);
		const ran = await runCli(
			["selfmod-run", "--proposal", proposalPath, "--worktree-root", fx.worktreeRoot, "--json"],
			fx.memoryDir,
			fx.repoRoot,
		);
		assert.equal(ran.code, 0, ran.stderr);
		const payload = JSON.parse(ran.stdout) as { outcome: string; record: { stage: string } };
		assert.equal(payload.outcome, "not-run");
		assert.equal(payload.record.stage, "propose");
		const status = await runCli(["selfmod-status", fx.id, "--json"], fx.memoryDir, fx.repoRoot);
		assert.equal(status.code, 0, status.stderr);
		const dumped = JSON.parse(status.stdout) as { stage: string; proposal: { id: string } };
		assert.equal(dumped.proposal.id, fx.id);
		assert.equal(dumped.stage, "propose");
		assert.equal((await readSelfmodRecords(fx.memoryDir)).length, 1);
	} finally {
		await destroyFixture(fx);
	}
});
