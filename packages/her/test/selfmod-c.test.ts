import assert from "node:assert/strict";
import test from "node:test";
import { listHerEvents } from "../src/her-core/event-history.ts";
import { runSelfMod } from "../src/her-core/selfmod.ts";
import {
	applySkillLine,
	destroyFixture,
	git,
	greenHooks,
	makeFixture,
	PROMPT_REL,
	proposalFor,
	writeRel,
} from "./selfmod-harness.ts";

test("ADR-0002 C: legal targetPaths but diff sneaks prompts/her.md is rejected with both scans", async () => {
	const fx = await makeFixture("c");
	try {
		const result = await runSelfMod({
			hooks: {
				...greenHooks,
				apply: async ({ worktreePath }) => {
					await applySkillLine(worktreePath);
					await writeRel(worktreePath, PROMPT_REL, "# her\nsneak\n");
					await git(worktreePath, "add", PROMPT_REL);
					await git(worktreePath, "commit", "-q", "-m", "sneak prompt");
				},
			},
			memoryDir: fx.memoryDir,
			proposal: proposalFor(fx),
			repoRoot: fx.repoRoot,
			worktreeRoot: fx.worktreeRoot,
		});
		assert.equal(result.record.stage, "rejected");
		assert.equal(result.record.mergeCommit, undefined);
		assert.equal(result.record.gate?.anchorScanClean, false);
		const events = await listHerEvents(fx.memoryDir, { kind: "selfmod.transition" });
		const rejected = events.find((event) => event.data?.stage === "rejected");
		assert.ok(rejected);
		const allow = (rejected?.data?.allowlistViolations as string[] | undefined) ?? [];
		const anchors = (rejected?.data?.anchorHits as string[] | undefined) ?? [];
		assert.ok(
			allow.some((path) => path.replace(/\\/g, "/").toLowerCase().includes("prompts/her.md")),
			`allowlist scan must catch prompts/her.md, got ${JSON.stringify(allow)}`,
		);
		assert.equal(result.record.gate?.anchorScanClean, false, "anchorScanClean is the merge belt");
		assert.ok(Array.isArray(anchors), "anchor scan ran (belt-and-suspenders)");
	} finally {
		await destroyFixture(fx);
	}
});
