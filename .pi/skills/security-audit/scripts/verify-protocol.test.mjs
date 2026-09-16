import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseShasums, verifyProtocol } from "./verify-protocol.mjs";

const UPSTREAM = "D:/@Product Design/N1 Line/n1-line/skills/n1-review/references/security-audit";

function fixture(files) {
	const dir = mkdtempSync(join(tmpdir(), "protocol-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

test("parses sha256sum format, including the two-space separator", () => {
	const parsed = parseShasums("abc123  LICENSE\ndef456  README.md\n");
	assert.deepEqual(parsed, [
		{ hash: "abc123", file: "LICENSE" },
		{ hash: "def456", file: "README.md" },
	]);
});

test("a manifest line that is not hash + path is refused, not skipped", () => {
	// A silently skipped line is a file nobody checks.
	assert.throws(() => parseShasums("abc123 LICENSE\n"), /line 1/);
	assert.throws(() => parseShasums("not-a-hash  LICENSE\n"), /line 1/);
});

test("the real upstream protocol verifies clean", () => {
	if (!existsSync(UPSTREAM)) {
		console.log("upstream protocol not present here — gate unverified against the real manifest");
		return;
	}
	const result = verifyProtocol(UPSTREAM);
	assert.equal(result.mismatched.length, 0, `mismatched: ${result.mismatched.map((m) => m.file).join(", ")}`);
	assert.equal(result.missing.length, 0, `missing: ${result.missing.join(", ")}`);
	assert.ok(result.pinned >= 20, `expected the whole protocol pinned, got ${result.pinned}`);
	assert.equal(result.verified, result.pinned);
	console.log(`upstream: ${result.verified}/${result.pinned} verified, ${result.normalized} via CRLF→LF`);
	assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);
	// The manifest's own digest is the anchor a later run compares against; if it
	// is not stable across two reads the gate is measuring noise.
	assert.equal(verifyProtocol(UPSTREAM).manifestDigest, result.manifestDigest);
});

test("a changed byte is caught", () => {
	// The gate has to be shown failing on purpose, or its green means nothing.
	const dir = fixture({
		"a.md": "hello\n",
		"SHASUMS.sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.md\n",
	});
	try {
		const clean = verifyProtocol(dir);
		assert.equal(clean.ok, true, "baseline fixture verifies before tampering");

		writeFileSync(join(dir, "a.md"), "hello!\n");
		const tampered = verifyProtocol(dir);
		assert.equal(tampered.ok, false);
		assert.equal(tampered.mismatched.length, 1);
		assert.equal(tampered.mismatched[0].file, "a.md");
		assert.match(tampered.mismatched[0].actual, /^[0-9a-f]{64}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a CRLF working tree still matches an LF manifest, and says so", () => {
	// Hashing raw bytes only makes every file on a Windows checkout red, which
	// reads as a tampered protocol and is really a broken gate. The fallback is
	// deliberate, so it gets a test: remove it and this goes red.
	const dir = fixture({
		"a.md": "hello\r\nworld\r\n",
		"SHASUMS.sha256": "8d8b5f7b0b8d08c0f3d0b1d0bf0e1b5c7a0f6d0c0e0a0b0c0d0e0f0a0b0c0d0e  a.md\n",
	});
	try {
		// The pinned hash is the LF form of the same content.
		const lfHash = createHash("sha256").update("hello\nworld\n").digest("hex");
		writeFileSync(join(dir, "SHASUMS.sha256"), `${lfHash}  a.md\n`);

		const result = verifyProtocol(dir);
		assert.equal(result.ok, true, JSON.stringify(result.mismatched));
		assert.equal(result.verified, 1);
		assert.equal(result.normalized, 1, "the run's metadata should show this matched only after normalising");

		// A real content change still fails both comparisons.
		writeFileSync(join(dir, "a.md"), "hello\r\nWORLD\r\n");
		assert.equal(verifyProtocol(dir).ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file present but absent from the manifest is reported as unpinned", () => {
	// The one-sided version of this gate only walks the manifest, so an ADDED
	// file passes silently — which is the shape of most supply-chain trouble.
	const dir = fixture({
		"a.md": "hello\n",
		"SHASUMS.sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.md\n",
	});
	try {
		assert.deepEqual(verifyProtocol(dir).unpinned, []);
		writeFileSync(join(dir, "extra.md"), "an extra companion nobody pinned\n");
		const result = verifyProtocol(dir);
		assert.deepEqual(result.unpinned, ["extra.md"]);
		assert.equal(result.ok, false, "an unpinned file is not a clean protocol");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a manifest entry with no file is missing, not silently fine", () => {
	const dir = fixture({
		"SHASUMS.sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.md\n",
	});
	try {
		const result = verifyProtocol(dir);
		assert.deepEqual(result.missing, ["a.md"]);
		assert.equal(result.ok, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("no manifest at all is a stated failure, not an exception", () => {
	const dir = fixture({ "a.md": "hello\n" });
	try {
		const result = verifyProtocol(dir);
		assert.equal(result.ok, false);
		assert.match(result.reason, /SHASUMS/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a known local addition is still listed, but does not make the gate red", () => {
	// The vendoring record sits next to the protocol and is deliberately outside
	// the upstream manifest. Waiving it silently would hide a real added file
	// later, so it stays in `unpinned` and only leaves `unexpectedUnpinned`.
	const dir = fixture({
		"a.md": "hello\n",
		"PROVENANCE.md": "where this came from\n",
		"SHASUMS.sha256": "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  a.md\n",
	});
	try {
		assert.equal(verifyProtocol(dir).ok, false, "unwaived, an extra file is red");

		const waived = verifyProtocol(dir, { expectUnpinned: ["PROVENANCE.md"] });
		assert.equal(waived.ok, true);
		assert.deepEqual(waived.unpinned, ["PROVENANCE.md"], "still reported");
		assert.deepEqual(waived.unexpectedUnpinned, []);

		// The waiver covers that one name only.
		writeFileSync(join(dir, "surprise.md"), "nobody pinned me either\n");
		const withSurprise = verifyProtocol(dir, { expectUnpinned: ["PROVENANCE.md"] });
		assert.equal(withSurprise.ok, false);
		assert.deepEqual(withSurprise.unexpectedUnpinned, ["surprise.md"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
