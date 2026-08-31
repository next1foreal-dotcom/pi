#!/usr/bin/env node
/**
 * G-354 — worker channel probe: alive/version via `--version`, quota from ops/channel-quota.yaml.
 *
 * 探针绿 ≠ 有额度;额度以口径文件与 Fei 为准。
 *
 * Usage:
 *   node packages/her/scripts/probe-worker-channels.mjs
 *   node packages/her/scripts/probe-worker-channels.mjs --json
 *   node packages/her/scripts/probe-worker-channels.mjs --quota-file <path>
 *   node packages/her/scripts/probe-worker-channels.mjs --channels grok,codex
 *   node packages/her/scripts/probe-worker-channels.mjs --write-latest
 *   node packages/her/scripts/probe-worker-channels.mjs --write-latest --latest-file <path>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CHANNELS = ["grok", "cursor-agent", "codex", "claude"];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_QUOTA_FILE = join(REPO_ROOT, "ops", "channel-quota.yaml");
export const CHANNEL_PROBE_LATEST_RELATIVE = join("ops", "channel-probe-latest.json");
export const DEFAULT_LATEST_FILE = join(REPO_ROOT, CHANNEL_PROBE_LATEST_RELATIVE);
const CHANNEL_NAME_RE = /^[A-Za-z0-9._-]+$/;
const VERSION_TIMEOUT_MS = 25_000;
export const QUOTA_DISCLAIMER = "探针绿 ≠ 有额度;额度以口径文件与 Fei 为准。";

/** Flat `name: text` YAML. Missing file → empty map (callers treat as quota "unknown"). */
export function loadQuotaMap(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
		throw err;
	}
	/** @type {Record<string, string>} */
	const quota = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "").trim();
		if (!line) continue;
		const match = /^([A-Za-z0-9._-]+)\s*:\s*(.+)$/.exec(line);
		if (!match) continue;
		const value = match[2].trim().replace(/^["']|["']$/g, "");
		if (value) quota[match[1]] = value;
	}
	return quota;
}

/**
 * Windows: a single shell string, not an args array (DEP0190) and not where.exe+.cmd
 * re-quoting (that path reported cursor-agent dead while `cursor-agent --version` works).
 * Channel names are allowlisted, so interpolating `name` into the shell line is safe.
 * @param {string} name
 * @returns {{ version: string | null, error: string | null }}
 */
function probeOne(name) {
	const result =
		process.platform === "win32"
			? spawnSync(`${name} --version`, {
					encoding: "utf8",
					timeout: VERSION_TIMEOUT_MS,
					windowsHide: true,
					shell: true,
					stdio: ["ignore", "pipe", "pipe"],
				})
			: spawnSync(name, ["--version"], {
					encoding: "utf8",
					timeout: VERSION_TIMEOUT_MS,
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
	const spawnError = result.error;
	const errText = spawnError
		? spawnError.code === "ENOENT"
			? `not found: ${name}`
			: spawnError.message
		: "";
	const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	const first = (out.split(/\r?\n/)[0] ?? "").trim();
	const alive = result.status === 0 && first.length > 0;
	if (alive) return { version: first.slice(0, 120), error: null };
	const error = errText || first || `exit ${result.status ?? "null"}`;
	return { version: null, error: error.slice(0, 200) };
}

/**
 * @param {string[]} names
 * @param {{ quota?: Record<string, string> }} [options]
 */
export function probeChannels(names, options = {}) {
	const quota = options.quota ?? {};
	return names.map((name) => {
		if (!CHANNEL_NAME_RE.test(name)) {
			throw new Error(`invalid channel name: ${name}`);
		}
		const probed = probeOne(name);
		return {
			name,
			alive: probed.error === null,
			version: probed.version,
			error: probed.error,
			quota: quota[name] ?? "unknown",
		};
	});
}

/**
 * @param {Array<{ name: string, alive: boolean, version: string | null, error: string | null, quota: string }>} channels
 */
export function formatHuman(channels) {
	const lines = ["worker 通道探针", ""];
	for (const channel of channels) {
		const mark = channel.alive ? "活" : "死";
		const detail = channel.alive ? (channel.version ?? "") : (channel.error ?? "(不可用)");
		lines.push(`  ${mark}  ${channel.name.padEnd(13)} ${detail}`);
		lines.push(`      quota: ${channel.quota}`);
	}
	lines.push("");
	lines.push(QUOTA_DISCLAIMER);
	return `${lines.join("\n")}\n`;
}

/**
 * @param {string[]} argv
 */
export function parseProbeArgs(argv) {
	const out = {
		json: false,
		writeLatest: false,
		channels: DEFAULT_CHANNELS,
		quotaFile: DEFAULT_QUOTA_FILE,
		latestFile: DEFAULT_LATEST_FILE,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--json") out.json = true;
		else if (arg === "--write-latest") out.writeLatest = true;
		else if (arg === "--channels") {
			i += 1;
			out.channels = (argv[i] ?? "")
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (arg === "--quota-file") {
			i += 1;
			out.quotaFile = resolve(argv[i] ?? "");
		} else if (arg === "--latest-file") {
			i += 1;
			out.latestFile = resolve(argv[i] ?? "");
		}
	}
	return out;
}

/**
 * Atomically write `{ at, channels }` (same channel rows as `--json`, wrapped with ISO `at`).
 * @param {string} path
 * @param {Array<{ name: string, alive: boolean, version: string | null, error: string | null, quota: string }>} channels
 * @param {string} [at]
 */
export function writeLatestArchive(path, channels, at = new Date().toISOString()) {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const body = `${JSON.stringify({ at, channels })}\n`;
	const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
	writeFileSync(tmp, body, "utf8");
	try {
		renameSync(tmp, path);
	} catch {
		try {
			unlinkSync(path);
		} catch {
			// dest may not exist; the second rename is the real failure if this also throws
		}
		renameSync(tmp, path);
	}
}

function isMain() {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url).toLowerCase() === resolve(entry).toLowerCase();
	} catch {
		return false;
	}
}

function main(argv = process.argv.slice(2)) {
	const args = parseProbeArgs(argv);
	const quota = loadQuotaMap(args.quotaFile);
	const channels = probeChannels(args.channels, { quota });
	if (args.writeLatest) writeLatestArchive(args.latestFile, channels);
	if (args.json) process.stdout.write(`${JSON.stringify(channels)}\n`);
	else process.stdout.write(formatHuman(channels));
	process.exit(channels.some((channel) => channel.alive) ? 0 : 1);
}

if (isMain()) main();
