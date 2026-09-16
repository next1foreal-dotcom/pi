import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decodeStream, runValidator, toWslPath, validateRun } from "./validate.mjs";

const SKILL = "D:/@Product Design/N1 Line/n1-line/skills/n1-review/references/security-audit";
const RUN_1 = "C:/Users/Admin/security-audit-skill/n1-line/run-1";

function haveWsl() {
	return existsSync(SKILL) && process.platform === "win32";
}

test("drive paths convert, including the one with a space in it", () => {
	assert.equal(toWslPath(String.raw`D:\@Product Design\N1 Line\x.cjs`), "/mnt/d/@Product Design/N1 Line/x.cjs");
	assert.equal(toWslPath("C:/Users/Admin/run-1/findings.json"), "/mnt/c/Users/Admin/run-1/findings.json");
});

test("anything not an absolute drive path is refused, not guessed", () => {
	// A relative path would resolve against the WSL home and validate some other
	// file — or none — and the run would report that as a result.
	assert.equal(toWslPath("run-1/findings.json"), null);
	assert.equal(toWslPath("/already/posix"), null);
	assert.equal(toWslPath(""), null);
});

test("wsl.exe's UTF-16 notices decode as text, not as spaced-out mojibake", () => {
	const utf16 = Buffer.from("wsl: A localhost proxy configuration was detected", "utf16le");
	assert.match(decodeStream(utf16), /^wsl: A localhost proxy/);
	assert.equal(decodeStream(Buffer.from("PASS: 10 coverage units valid\n", "utf8")), "PASS: 10 coverage units valid\n");
	assert.equal(decodeStream(Buffer.alloc(0)), "");
	assert.equal(decodeStream(null), "");
});

test("a missing input is a stated reason, not a pass", () => {
	const dir = mkdtempSync(join(tmpdir(), "run-"));
	try {
		const result = runValidator("ledger", { runDir: dir, skillDir: SKILL });
		assert.equal(result.ok, false);
		assert.match(result.reason, /input not found/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown validator name throws instead of reporting clean", () => {
	assert.throws(() => runValidator("nonsense", { runDir: RUN_1, skillDir: SKILL }), /unknown validator/);
});

test("run-1's artifacts pass both validators", { timeout: 120_000 }, () => {
	if (!haveWsl() || !existsSync(RUN_1)) {
		console.log("WSL or run-1 not available here — runner unverified against the real validators");
		return;
	}
	const { ok, results } = validateRun({ runDir: RUN_1, skillDir: SKILL });
	for (const r of results) console.log(`${r.kind}: exit ${r.code} — ${r.stdout.trim().split("\n").pop()}`);
	assert.equal(ok, true, JSON.stringify(results.map((r) => ({ kind: r.kind, code: r.code, reason: r.reason }))));
});

test("a broken ledger comes back non-zero — the gate has been shown failing", { timeout: 120_000 }, () => {
	if (!haveWsl()) {
		console.log("WSL not available here — the failing side of this gate is unverified");
		return;
	}
	const dir = mkdtempSync(join(tmpdir(), "run-"));
	try {
		writeFileSync(join(dir, "coverage-ledger.json"), JSON.stringify([{ coverage_id: "not::a::real::unit" }]));
		const result = runValidator("ledger", { runDir: dir, skillDir: SKILL });
		assert.equal(result.ok, false, "a unit missing every required field must not validate");
		assert.notEqual(result.code, 0);
		console.log(`broken ledger: exit ${result.code}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
