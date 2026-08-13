import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendAuditLog, redactAuditPath } from "../src/lib/audit.ts";

test("redactAuditPath keeps her-memory relative paths and strips drive-absolute PII", () => {
	assert.equal(redactAuditPath("her-memory/narrative/SOUL.md"), "her-memory/narrative/SOUL.md");
	assert.equal(redactAuditPath("D:\\@Her\\her-memory\\narrative\\SOUL.md"), "her-memory/narrative/SOUL.md");
	assert.equal(redactAuditPath("C:\\Users\\Admin\\secret\\notes.md"), "<redacted-abs>");
	assert.equal(redactAuditPath("/home/fei/.env"), "<redacted-abs>");
	assert.equal(redactAuditPath("packages/her/src/extension.ts"), "packages/her/src/extension.ts");
});

test("appendAuditLog does not persist absolute target paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-audit-pii-"));
	try {
		appendAuditLog(
			{
				ts: "2026-08-13T12:00:00.000Z",
				tool: "write",
				verdict: "DENY",
				rule: "forbid_anchor_write",
				context: { targetPath: "D:\\@Her\\her-memory\\narrative\\SOUL.md", cwd: "D:\\@Her\\Her-repo" },
			},
			root,
		);
		const raw = await readFile(join(root, "audit", "2026-08-13.jsonl"), "utf8");
		assert.doesNotMatch(raw, /D:\\\\@Her/);
		assert.doesNotMatch(raw, /D:\\@Her/);
		const entry = JSON.parse(raw) as { context: { targetPath: string; cwd: string } };
		assert.equal(entry.context.targetPath, "her-memory/narrative/SOUL.md");
		assert.equal(entry.context.cwd, "<redacted-abs>");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
