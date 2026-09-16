/**
 * Gate 1: is the protocol I am about to run the one I think I am running?
 *
 * The audit protocol ships with a SHASUMS.sha256 manifest. When the protocol
 * lives inside the repository being audited — which is exactly the run-2 case —
 * "the rules" and "the thing under test" are the same bytes, and a change to
 * either is invisible without a check.
 *
 * Deliberately two-sided. Walking only the manifest catches a CHANGED file and
 * misses an ADDED one, and an unpinned companion dropped into the protocol
 * directory is read by every hunter with no integrity check at all. So the
 * directory is walked too, and an unpinned file makes the gate red unless the
 * caller names it as a known local addition — it is still listed either way.
 *
 * Usage: node verify-protocol.mjs <protocol-dir> [--json] [--expect-unpinned a.md,b.md]
 *
 * Upstream protocol: Cloudflare security-audit skill (MIT) — see ../LICENSE.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MANIFEST = "SHASUMS.sha256";

export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * sha256sum's own output format: 64 hex, two spaces, path. Anything else throws
 * with its line number — a manifest line this parser does not understand is a
 * file nobody is checking, and skipping it quietly is how that stays true.
 */
export function parseShasums(text) {
	const entries = [];
	const lines = text.split(/\r?\n/);
	for (const [i, line] of lines.entries()) {
		if (line.trim() === "") continue;
		// sha256sum writes "<hash><space><mode><path>", mode being " " for text and
		// "*" for binary. Both are accepted; a single space is not, because that is
		// a hand-edited line and the path it names may not be the path it looks like.
		const match = /^([0-9a-f]{6,128}) ([ *])(.+)$/.exec(line);
		if (!match) throw new Error(`${MANIFEST} line ${i + 1} is not "<hash>  <path>": ${JSON.stringify(line)}`);
		entries.push({ hash: match[1], file: match[3] });
	}
	return entries;
}

/** Files in the protocol directory that a manifest is expected to cover. */
function listProtocolFiles(dir) {
	return readdirSync(dir)
		.filter((name) => name !== MANIFEST)
		.filter((name) => {
			try {
				return statSync(join(dir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
}

/**
 * @param dir             the protocol directory
 * @param expectUnpinned  files known to be local additions rather than upstream
 *                        content (the vendoring record, for one). They stay in
 *                        `unpinned` so a run's metadata still shows them; they
 *                        just do not make the gate red. Anything NOT on this
 *                        list lands in `unexpectedUnpinned` and does.
 */
export function verifyProtocol(dir, { expectUnpinned = [] } = {}) {
	let manifestText;
	let manifestBytes;
	try {
		manifestBytes = readFileSync(join(dir, MANIFEST));
		manifestText = manifestBytes.toString("utf8");
	} catch (error) {
		return {
			dir,
			ok: false,
			reason: `cannot read ${MANIFEST}: ${String(error.message ?? error)}`,
			pinned: 0,
			verified: 0,
			mismatched: [],
			missing: [],
			unpinned: [],
		};
	}

	const entries = parseShasums(manifestText);
	const mismatched = [];
	const missing = [];
	let verified = 0;
	let normalized = 0;

	for (const entry of entries) {
		let bytes;
		try {
			bytes = readFileSync(join(dir, entry.file));
		} catch {
			missing.push(entry.file);
			continue;
		}
		// Compare over the manifest's own hash length so a short-form manifest
		// still compares meaningfully rather than always failing.
		const fits = (hash) => hash.slice(0, entry.hash.length) === entry.hash;
		const raw = sha256(bytes);
		if (fits(raw)) {
			verified++;
			continue;
		}
		// The manifest pins content as git stores it (LF). A Windows checkout with
		// core.autocrlf has CRLF in the working tree, so hashing raw bytes makes
		// EVERY file red — which is what a broken gate looks like, not a tampered
		// protocol. Falling back to the LF form is deliberate: line endings here
		// are a checkout artifact, and the count is reported so a run's metadata
		// says which comparison actually passed.
		const lf = sha256(Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8"));
		if (fits(lf)) {
			verified++;
			normalized++;
			continue;
		}
		mismatched.push({ file: entry.file, expected: entry.hash, actual: raw, actualLf: lf });
	}

	const pinnedNames = new Set(entries.map((e) => e.file));
	const unpinned = listProtocolFiles(dir).filter((name) => !pinnedNames.has(name));
	const expected = new Set(expectUnpinned);
	const unexpectedUnpinned = unpinned.filter((name) => !expected.has(name));

	return {
		dir,
		ok: mismatched.length === 0 && missing.length === 0 && unexpectedUnpinned.length === 0,
		unexpectedUnpinned,
		manifestDigest: sha256(manifestBytes),
		pinned: entries.length,
		verified,
		normalized,
		mismatched,
		missing,
		unpinned,
	};
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
	const [, , dir, ...rest] = process.argv;
	if (!dir) {
		console.error("usage: node verify-protocol.mjs <protocol-dir> [--json] [--expect-unpinned a.md,b.md]");
		process.exit(2);
	}
	const expectIndex = rest.indexOf("--expect-unpinned");
	const expectUnpinned = expectIndex >= 0 ? (rest[expectIndex + 1] ?? "").split(",").filter(Boolean) : [];
	const result = verifyProtocol(dir, { expectUnpinned });
	if (rest.includes("--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		console.log(`dir: ${result.dir}`);
		if (result.reason) console.log(`reason: ${result.reason}`);
		else {
			console.log(`manifest digest: ${result.manifestDigest}`);
			console.log(`pinned ${result.pinned}, verified ${result.verified}` + (result.normalized ? ` (${result.normalized} matched only after CRLF→LF)` : ""));
			for (const m of result.mismatched) console.log(`CHANGED  ${m.file}\n  expected ${m.expected}\n  actual   ${m.actual}`);
			for (const f of result.missing) console.log(`MISSING  ${f}`);
			for (const f of result.unpinned) {
				console.log(`${result.unexpectedUnpinned.includes(f) ? "UNPINNED" : "unpinned"} ${f}`);
			}
		}
		console.log(result.ok ? "protocol OK" : "protocol NOT clean");
	}
	process.exit(result.ok ? 0 : 1);
}
