/**
 * coverage_id derivation, exactly as RECONNAISSANCE.md specifies.
 *
 * NFC-normalise each ref, then percent-encode with only A-Z a-z 0-9 - . _ ~
 * left bare and %HH uppercase, and join the four refs with "::". Getting this
 * wrong is silent: two units that should be one get separate ids, the ledger
 * looks broader than the run actually was, and validate-coverage-ledger.cjs
 * cannot tell because each id is individually well-formed.
 *
 * Ported from the run-1 parent scripts, which validated clean against the
 * upstream validators. Kept as its own module so the encoder has one home and
 * one test, rather than being retyped per run.
 *
 * Upstream protocol: Cloudflare security-audit skill (MIT) — see ../LICENSE.
 */

/** Characters that must never appear in a ref: controls, zero-width, BOM, line separators. */
function hasForbiddenChar(text) {
	for (const ch of text) {
		const code = ch.codePointAt(0);
		if (code < 0x20 || code === 0x7f) return true;
		if (code >= 0x200b && code <= 0x200f) return true;
		if (code === 0x2028 || code === 0x2029 || code === 0xfeff) return true;
	}
	return false;
}

/**
 * Percent-encode one canonical ref. Throws rather than silently normalising:
 * a ref with a stray zero-width space still encodes to something plausible,
 * and then nothing downstream can tell you why two runs disagree.
 */
export function encodeRef(ref) {
	if (typeof ref !== "string") throw new TypeError(`ref must be a string, got ${typeof ref}`);
	const normalized = ref.normalize("NFC");
	if (normalized === "") throw new Error("ref is empty");
	// Character class before whitespace: JS trim() eats BOM, newlines and other
	// invisibles, so checking trim() first reports "leading/trailing space" for a
	// ref whose actual problem is a zero-width character — and sends whoever
	// reads the error looking for a space that is not there.
	if (hasForbiddenChar(normalized)) throw new Error(`ref has a control or zero-width character: ${JSON.stringify(ref)}`);
	if (normalized !== normalized.trim()) throw new Error(`ref has leading/trailing space: ${JSON.stringify(ref)}`);

	let out = "";
	for (const byte of Buffer.from(normalized, "utf8")) {
		const ch = String.fromCharCode(byte);
		out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/** The four canonical refs, in the order the id joins them. */
export const REF_ORDER = ["surface", "boundary", "subsystem", "attack_class"];

/**
 * Build a coverage_id from canonical refs. Every ref is required — a unit
 * missing one is not a coarser unit, it is an unanswerable one.
 */
export function coverageId(refs) {
	const missing = REF_ORDER.filter((key) => !(key in refs));
	if (missing.length > 0) throw new Error(`canonical_refs is missing: ${missing.join(", ")}`);
	return REF_ORDER.map((key) => encodeRef(refs[key])).join("::");
}

/** The fixed subsystem ref a quick-profile run uses for every unit. */
export const QUICK_SUBSYSTEM = "profile/quick/all-in-scope-subsystems";
