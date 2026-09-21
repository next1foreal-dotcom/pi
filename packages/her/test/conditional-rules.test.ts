import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConditionalRules, loadConditionalRules } from "../src/conditional-rules.ts";

test("conditional rules load only referenced nested AGENTS and stay pinned to the session", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-conditional-rules-"));
	await mkdir(join(root, "packages", "web", "src"), { recursive: true });
	await mkdir(join(root, "packages", "api", "src"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "root is loaded by the host", "utf8");
	await writeFile(join(root, "packages", "web", "AGENTS.md"), "keep web changes accessible", "utf8");
	await writeFile(join(root, "packages", "api", "AGENTS.md"), "never expose secrets", "utf8");
	await writeFile(join(root, "packages", "web", "src", "view.ts"), "export {};", "utf8");

	clearConditionalRules();
	const selected = await loadConditionalRules({
		cwd: root,
		prompt: "Edit packages/web/src/view.ts",
		sessionId: "session-a",
	});
	assert.equal(selected.length, 1);
	assert.match(selected[0]?.source ?? "", /packages[\\/]web[\\/]AGENTS\.md$/);
	assert.match(selected[0]?.content ?? "", /keep web changes accessible/);
	assert.doesNotMatch(selected[0]?.content ?? "", /root is loaded|never expose secrets/);

	const pinned = await loadConditionalRules({ cwd: root, prompt: "continue", sessionId: "session-a" });
	assert.deepEqual(pinned, selected);
	assert.deepEqual(await loadConditionalRules({ cwd: root, prompt: "continue", sessionId: "session-b" }), []);
});
