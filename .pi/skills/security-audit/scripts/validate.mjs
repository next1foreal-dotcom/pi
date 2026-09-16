/**
 * The two upstream validators, run where they can actually run.
 *
 * Both refuse to open their input on Windows: `fs.constants.O_NOFOLLOW` and
 * `O_NONBLOCK` are undefined on win32, and their `readFileWithinLimit` guard
 * throws "OS no-follow and nonblocking input protection is unavailable". That is
 * the tool protecting itself, not a broken machine — do not try to fix it here.
 * Run them under WSL, which has the POSIX flags.
 *
 * A run has exactly two terminal states, and this is the one that decides the
 * good one: both validators exit 0. So nothing here is piped, nothing is
 * `|| true`, and the verdict is the exit code — never a line of output that
 * happens to look reassuring. spawnSync with an argv array also keeps paths with
 * spaces ("@Product Design") out of any shell's hands.
 *
 * Usage: node validate.mjs <run-dir> --skill <protocol-dir> [--what ledger|findings|both]
 *                          [--distro Ubuntu-24.04-Tapix-CI]
 *
 * Upstream protocol: Cloudflare security-audit skill (MIT) — see ../LICENSE.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DISTRO = "Ubuntu-24.04-Tapix-CI";

export const VALIDATORS = {
	ledger: { script: "validate-coverage-ledger.cjs", input: "coverage-ledger.json" },
	findings: { script: "validate-findings.cjs", input: "findings.json" },
};

/**
 * `D:\@Product Design\x` → `/mnt/d/@Product Design/x`.
 *
 * Returns null rather than a plausible-looking path for anything that is not an
 * absolute drive path: a relative path silently resolved against the WSL home
 * would validate some other file, or none, and report that as a result.
 */
export function toWslPath(windowsPath) {
	const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
	if (!match) return null;
	return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** wsl.exe speaks UTF-16LE for its own notices; the program it launches speaks UTF-8. */
export function decodeStream(buffer) {
	if (!buffer || buffer.length === 0) return "";
	const nulls = buffer.subarray(0, Math.min(buffer.length, 64)).filter((b) => b === 0).length;
	return buffer.toString(nulls > 8 ? "utf16le" : "utf8");
}

/** Run one validator. The verdict is `code`; `stdout` is for the reader, not for the gate. */
export function runValidator(kind, { runDir, skillDir, distro = DEFAULT_DISTRO }) {
	const spec = VALIDATORS[kind];
	if (!spec) throw new Error(`unknown validator ${kind}; expected one of ${Object.keys(VALIDATORS).join(", ")}`);

	const scriptWin = join(skillDir, spec.script);
	const inputWin = join(runDir, spec.input);
	const script = toWslPath(scriptWin);
	const input = toWslPath(inputWin);
	if (!script) return { kind, ok: false, code: null, reason: `not an absolute Windows path: ${scriptWin}` };
	if (!input) return { kind, ok: false, code: null, reason: `not an absolute Windows path: ${inputWin}` };
	if (!existsSync(scriptWin)) return { kind, ok: false, code: null, reason: `validator not found: ${scriptWin}` };
	if (!existsSync(inputWin)) return { kind, ok: false, code: null, reason: `input not found: ${inputWin}` };

	const args = ["-d", distro, "-e", "node", script, input];
	// Buffers, not strings: node inside WSL writes UTF-8 on stdout, but wsl.exe
	// writes its OWN notices (proxy warnings, distro errors) on stderr as
	// UTF-16LE. Decoding everything as UTF-8 turns those into "w s l :   A"
	// spaced-out mojibake in the run report.
	const run = spawnSync("wsl.exe", args, { maxBuffer: 32 * 1024 * 1024 });

	if (run.error) {
		return { kind, ok: false, code: null, reason: `wsl.exe failed to start: ${run.error.message}`, commandLine: ["wsl.exe", ...args] };
	}
	return {
		kind,
		// A validator killed by a signal has status null. Treating that as a pass
		// because "there were no errors printed" is how a run reports clean after
		// nothing checked it.
		ok: run.status === 0,
		code: run.status,
		signal: run.signal ?? null,
		stdout: decodeStream(run.stdout),
		stderr: decodeStream(run.stderr),
		commandLine: ["wsl.exe", ...args],
	};
}

export function validateRun({ runDir, skillDir, what = "both", distro = DEFAULT_DISTRO }) {
	const kinds = what === "both" ? Object.keys(VALIDATORS) : [what];
	const results = kinds.map((kind) => runValidator(kind, { runDir, skillDir, distro }));
	return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly =
	process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
	const argv = process.argv.slice(2);
	const runDir = argv[0];
	const flag = (name, fallback) => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : fallback;
	};
	const skillDir = flag("skill");
	if (!runDir || !skillDir) {
		console.error("usage: node validate.mjs <run-dir> --skill <protocol-dir> [--what ledger|findings|both] [--distro NAME]");
		process.exit(2);
	}

	const { ok, results } = validateRun({
		runDir,
		skillDir,
		what: flag("what", "both"),
		distro: flag("distro", DEFAULT_DISTRO),
	});

	for (const r of results) {
		console.log(`== ${r.kind} ==`);
		if (r.commandLine) console.log(`$ ${r.commandLine.join(" ")}`);
		if (r.reason) console.log(`reason: ${r.reason}`);
		if (r.stdout?.trim()) console.log(r.stdout.trim());
		if (r.stderr?.trim()) console.log(`stderr: ${r.stderr.trim()}`);
		console.log(`exit code: ${r.code}${r.signal ? ` (signal ${r.signal})` : ""}`);
	}
	console.log(ok ? "both validators exit 0" : "NOT clean");
	process.exit(ok ? 0 : 1);
}
