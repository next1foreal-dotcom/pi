import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findStagedAnchorPaths } from "../../../.githooks/anchor-path-gate.ts";
import { authorizeSelfModTool } from "../src/lib/cedar.ts";
import { isAllowedSelfModPath, isAnchorPath } from "../src/rsi/anchors.ts";

test("anchor paths normalize separators and case", () => {
	assert.equal(isAnchorPath("HER-MEMORY\\NARRATIVE\\soul.MD"), true);
	assert.equal(isAnchorPath("packages/her/pi-package/policies/generated.cedar"), true);
	assert.equal(isAnchorPath("packages/her/src/rsi/anchors.ts"), true);
});

test("selfmod allows only the v1 skill path", () => {
	assert.equal(isAllowedSelfModPath("packages/her/pi-package/skills/foo/SKILL.md"), true);
	assert.equal(isAllowedSelfModPath("prompts/her.md"), false);
});

test("git gate finds staged policy paths", () => {
	assert.deepEqual(findStagedAnchorPaths(["README.md", "packages/her/pi-package/policies/fake.cedar"]), [
		"packages/her/pi-package/policies/fake.cedar",
	]);
});

test("git gate blocks staged anchors and permits an explicit override", async (t) => {
	const repository = await mkdtemp(join(tmpdir(), "her-rsi-git-gate-"));
	t.after(() => rm(repository, { force: true, recursive: true }));
	const policyPath = join(repository, "packages", "her", "pi-package", "policies", "fake.cedar");
	await mkdir(join(policyPath, ".."), { recursive: true });
	await writeFile(policyPath, "permit(principal, action, resource);\n", "utf8");
	for (const args of [
		["init", "--quiet"],
		["add", "packages/her/pi-package/policies/fake.cedar"],
	]) {
		const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const staged = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
		cwd: repository,
		encoding: "buffer",
	});
	assert.equal(staged.status, 0, staged.stderr.toString());
	const gate = resolve(".githooks", "anchor-path-gate.ts");
	const blocked = spawnSync(process.execPath, ["--experimental-strip-types", gate], {
		cwd: repository,
		encoding: "utf8",
		env: { ...process.env, HER_CEDAR_PROFILE: "default" },
		input: staged.stdout,
	});
	assert.notEqual(blocked.status, 0);
	assert.match(`${blocked.stdout}${blocked.stderr}`, /packages\/her\/pi-package\/policies\/fake\.cedar/);
	const overridden = spawnSync(process.execPath, ["--experimental-strip-types", gate], {
		cwd: repository,
		encoding: "utf8",
		env: { ...process.env, FEI_ANCHOR_OVERRIDE: "1", HER_CEDAR_PROFILE: "default" },
		input: staged.stdout,
	});
	assert.equal(overridden.status, 0, overridden.stderr);
	assert.match(`${overridden.stdout}${overridden.stderr}`, /override/i);
});

test("selfmod Cedar denies a memory anchor and audits the denial", async (t) => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-rsi-anchor-"));
	t.after(() => rm(memoryDir, { force: true, recursive: true }));
	const now = "2026-08-12T12:00:00.000Z";
	const verdict = authorizeSelfModTool({
		cwd: memoryDir,
		memoryDir,
		now,
		targetPath: "narrative/SOUL.md",
		toolCallId: "selfmod-anchor-test",
		toolName: "write",
	});

	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, ["selfmod_forbid_anchor_write"]);
	const audit = JSON.parse(await readFile(join(memoryDir, "audit", "2026-08-12.jsonl"), "utf8")) as {
		context: { anchorPath: boolean; targetPath: string };
		verdict: string;
	};
	assert.equal(audit.verdict, "DENY");
	assert.equal(audit.context.anchorPath, true);
	assert.equal(audit.context.targetPath, "her-memory/narrative/SOUL.md");
});

test("selfmod Cedar permits a v1 skill write", async (t) => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-rsi-allowed-"));
	t.after(() => rm(memoryDir, { force: true, recursive: true }));
	const verdict = authorizeSelfModTool({
		cwd: process.cwd(),
		memoryDir,
		targetPath: "packages/her/pi-package/skills/foo/SKILL.md",
		toolName: "edit",
	});
	assert.equal(verdict.decision, "allow");
});
