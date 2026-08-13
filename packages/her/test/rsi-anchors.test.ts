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

test("selfmod Cedar denies an unregistered tool writing a memory anchor (ADR-0002 #6)", async (t) => {
	const memoryDir = await mkdtemp(join(tmpdir(), "her-rsi-unregistered-"));
	t.after(() => rm(memoryDir, { force: true, recursive: true }));
	const now = "2026-08-13T12:00:00.000Z";
	const verdict = authorizeSelfModTool({
		cwd: memoryDir,
		memoryDir,
		now,
		targetPath: "her-memory/narrative/SOUL.md",
		toolCallId: "selfmod-unregistered-apply-patch",
		toolName: "apply_patch",
	});

	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, ["selfmod_forbid_anchor_write"]);
	const audit = JSON.parse(await readFile(join(memoryDir, "audit", "2026-08-13.jsonl"), "utf8")) as {
		context: { anchorPath: boolean; targetPath: string };
		tool: string;
		verdict: string;
	};
	assert.equal(audit.verdict, "DENY");
	assert.equal(audit.tool, "apply_patch");
	assert.equal(audit.context.anchorPath, true);
	assert.equal(audit.context.targetPath, "her-memory/narrative/SOUL.md");
});

// ADR-0002 V-06: the two gates are independent -- kill one, the other still blocks.
test("V-06a: with the git gate provably dead, Cedar still denies a SOUL.md write", async (t) => {
	const repository = await mkdtemp(join(tmpdir(), "her-v06-git-dead-"));
	t.after(() => rm(repository, { force: true, recursive: true }));
	// Reproduce the 2026-08-12 incident shape: hooksPath points at a directory
	// that does not exist in the checkout, so git runs no hook at all.
	const policyPath = join(repository, "packages", "her", "pi-package", "policies", "fake.cedar");
	await mkdir(join(policyPath, ".."), { recursive: true });
	await writeFile(policyPath, "permit(principal, action, resource);\n", "utf8");
	for (const args of [
		["init", "--quiet"],
		["config", "core.hooksPath", ".husky/_"],
		["add", "packages/her/pi-package/policies/fake.cedar"],
		["-c", "user.email=v06@test", "-c", "user.name=v06", "commit", "--quiet", "-m", "anchor sails through"],
	]) {
		const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
		assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	}
	// Gate 1 is dead: the anchor commit above succeeded. Gate 2 must still hold.
	const memoryDir = await mkdtemp(join(tmpdir(), "her-v06-memory-"));
	t.after(() => rm(memoryDir, { force: true, recursive: true }));
	const verdict = authorizeSelfModTool({
		cwd: memoryDir,
		memoryDir,
		now: "2026-08-13T13:00:00.000Z",
		targetPath: "narrative/SOUL.md",
		toolCallId: "v06-git-gate-dead",
		toolName: "write",
	});
	assert.equal(verdict.decision, "deny");
	assert.deepEqual(verdict.matched, ["selfmod_forbid_anchor_write"]);
	const audit = JSON.parse(await readFile(join(memoryDir, "audit", "2026-08-13.jsonl"), "utf8")) as {
		verdict: string;
	};
	assert.equal(audit.verdict, "DENY");
	// Independence by construction: the Cedar gate never consults git.
	const cedarSource = await readFile(resolve("packages", "her", "src", "lib", "cedar.ts"), "utf8");
	assert.doesNotMatch(cedarSource, /child_process|spawnSync|execSync|\bgit\b/);
});

test("V-06b: with Cedar absent by construction, the git gate still blocks staged evals and policies", async (t) => {
	const repository = await mkdtemp(join(tmpdir(), "her-v06-cedar-dead-"));
	t.after(() => rm(repository, { force: true, recursive: true }));
	const staged = ["her-memory/evals/graded.md", "packages/her/pi-package/policies/fake.cedar", "README.md"];
	for (const path of staged) {
		const absolute = join(repository, ...path.split("/"));
		await mkdir(join(absolute, ".."), { recursive: true });
		await writeFile(absolute, "v06\n", "utf8");
	}
	for (const args of [
		["init", "--quiet"],
		["add", "--all"],
	]) {
		const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const names = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
		cwd: repository,
		encoding: "buffer",
	});
	assert.equal(names.status, 0, names.stderr.toString());
	// Cedar absent by construction: the gate subprocess loads only the hook
	// script and anchors.ts, neither of which imports Cedar or the extension.
	const gatePath = resolve(".githooks", "anchor-path-gate.ts");
	for (const source of [gatePath, resolve("packages", "her", "src", "rsi", "anchors.ts")]) {
		assert.doesNotMatch(await readFile(source, "utf8"), /cedar|extension|governed-tools/i);
	}
	const environment = { ...process.env };
	delete environment.HER_CEDAR_PROFILE;
	delete environment.FEI_ANCHOR_OVERRIDE;
	const blocked = spawnSync(process.execPath, ["--experimental-strip-types", gatePath], {
		cwd: repository,
		encoding: "utf8",
		env: environment,
		input: names.stdout,
	});
	assert.notEqual(blocked.status, 0);
	const output = `${blocked.stdout}${blocked.stderr}`;
	assert.match(output, /her-memory\/evals\/graded\.md/);
	assert.match(output, /packages\/her\/pi-package\/policies\/fake\.cedar/);
	assert.doesNotMatch(output, /README\.md/);
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
