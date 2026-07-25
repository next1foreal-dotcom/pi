import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveExec } from "../src/exec/resolve.ts";
import { buildExecSpawnHints } from "../src/exec/spawn-hints.ts";
import { findProtectedPathViolation } from "../src/lib/paths.ts";

const piRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

test("protected paths block .env writes", () => {
	const hit = findProtectedPathViolation("write", { path: ".env" }, { cwd: "/tmp/ws" });
	assert.ok(hit);
	assert.equal(hit?.pattern, ".env");
});

test("protected paths allow normal source files", () => {
	const hit = findProtectedPathViolation("write", { path: "src/index.ts" }, { cwd: "/tmp/ws" });
	assert.equal(hit, undefined);
});

test("resolveExec defaults to native on win32", () => {
	const r = resolveExec({ platform: "win32", env: {}, cwd: "/tmp" });
	assert.equal(r.backend, "native");
});

test("bash-sandbox on win32 without WSL yields error", () => {
	const r = resolveExec({ platform: "win32", env: { HER_EXEC: "bash-sandbox" }, cwd: "/tmp" });
	assert.ok(r.errors.length > 0);
});

test("buildExecSpawnHints includes sandbox extension when present", () => {
	const hints = buildExecSpawnHints({
		piMonoRoot: piRoot,
		platform: "linux",
		env: { HER_EXEC: "bash-sandbox" },
		cwd: piRoot,
	});
	assert.equal(hints.backend, "bash-sandbox");
	if (hints.extraExtensions.length > 0) {
		assert.ok(hints.extraExtensions.some((p) => p.includes("sandbox")));
	}
});
