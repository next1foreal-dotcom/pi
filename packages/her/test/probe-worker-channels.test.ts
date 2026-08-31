/**
 * G-354 — worker-channel probe. Two sides required by the task packet:
 *   1. real names on this machine: grok.alive === true
 *   2. a name that cannot exist: alive === false and the probe does not throw
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "probe-worker-channels.mjs");

type Channel = {
	name: string;
	alive: boolean;
	version: string | null;
	error: string | null;
	quota: string;
};

function runProbe(args: string[]): ReturnType<typeof spawnSync> {
	return spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
}

function stdoutText(stdout: unknown): string {
	if (typeof stdout === "string") return stdout;
	if (stdout == null) return "";
	if (Buffer.isBuffer(stdout)) return stdout.toString("utf8");
	return String(stdout);
}

function parseChannels(stdout: unknown): Channel[] {
	return JSON.parse(stdoutText(stdout)) as Channel[];
}

test("G-354 probe real channels: grok is alive on this machine", () => {
	const result = runProbe(["--json"]);
	assert.equal(result.error, undefined, result.error instanceof Error ? result.error.message : "");
	const channels = parseChannels(result.stdout);
	const grok = channels.find((c) => c.name === "grok");
	assert.ok(grok, "grok row missing");
	assert.equal(grok.alive, true);
	assert.ok(grok.version && grok.version.length > 0, "alive grok must report a version");
	assert.equal(grok.error, null);
});

test("G-354 probe unknown CLI is dead and does not throw", () => {
	const result = runProbe(["--json", "--channels", "definitely-not-a-cli-xyz"]);
	assert.equal(result.error, undefined);
	assert.equal(result.status, 1);
	const channels = parseChannels(result.stdout);
	assert.equal(channels.length, 1);
	assert.equal(channels[0].name, "definitely-not-a-cli-xyz");
	assert.equal(channels[0].alive, false);
	assert.ok(channels[0].error && channels[0].error.length > 0);
	assert.equal(channels[0].version, null);
});

test("G-354 missing quota file is unknown, not an error", () => {
	const result = runProbe([
		"--json",
		"--channels",
		"definitely-not-a-cli-xyz",
		"--quota-file",
		join(tmpdir(), "g354-no-such-quota.yaml"),
	]);
	assert.equal(result.status, 1);
	const channels = parseChannels(result.stdout);
	assert.equal(channels[0].quota, "unknown");
});

test("G-354 quota file values attach to matching channel names", async () => {
	const dir = await mkdtemp(join(tmpdir(), "g354-quota-"));
	const path = join(dir, "channel-quota.yaml");
	await writeFile(
		path,
		["grok: 有量·当前主力", "cursor-agent: 额度尽·待恢复", "codex: 额度尽·待恢复", ""].join("\n"),
		"utf8",
	);
	const result = runProbe(["--json", "--channels", "grok", "--quota-file", path]);
	assert.equal(result.status, 0);
	const channels = parseChannels(result.stdout);
	assert.equal(channels[0].quota, "有量·当前主力");
});

test("G-354 CLI --json unknown channel exits 1 with alive false", () => {
	const result = runProbe(["--json", "--channels", "definitely-not-a-cli-xyz"]);
	assert.equal(result.status, 1);
	const parsed = parseChannels(result.stdout);
	assert.equal(parsed[0].alive, false);
	assert.equal(parsed[0].name, "definitely-not-a-cli-xyz");
});

test("G-354 CLI human output prints the quota disclaimer", () => {
	const result = runProbe([
		"--channels",
		"definitely-not-a-cli-xyz",
		"--quota-file",
		join(tmpdir(), "g354-missing-quota.yaml"),
	]);
	assert.match(stdoutText(result.stdout), /探针绿 ≠ 有额度;额度以口径文件与 Fei 为准/);
	assert.equal(result.status, 1);
});

test("G-356 --write-latest writes {at, channels} JSON to --latest-file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "g356-latest-"));
	const dest = join(dir, "channel-probe-latest.json");
	const result = runProbe([
		"--json",
		"--channels",
		"definitely-not-a-cli-xyz",
		"--write-latest",
		"--latest-file",
		dest,
	]);
	assert.equal(result.error, undefined);
	assert.equal(existsSync(dest), true, "flag must write the archive");
	const parsed = JSON.parse(readFileSync(dest, "utf8")) as {
		at: string;
		channels: Channel[];
	};
	assert.equal(typeof parsed.at, "string");
	assert.equal(Number.isNaN(Date.parse(parsed.at)), false, "at must be ISO-parseable");
	assert.equal(Array.isArray(parsed.channels), true);
	assert.equal(parsed.channels.length, 1);
	assert.equal(parsed.channels[0].name, "definitely-not-a-cli-xyz");
	assert.equal(parsed.channels[0].alive, false);
	const stdoutChannels = parseChannels(result.stdout);
	assert.deepEqual(parsed.channels, stdoutChannels);
});

test("G-361 default channels include all four worker CLIs", () => {
	const result = runProbe(["--json"]);
	assert.equal(result.error, undefined, result.error instanceof Error ? result.error.message : "");
	const channels = parseChannels(result.stdout);
	const names = channels.map((c) => c.name);
	assert.deepEqual(names, ["grok", "cursor-agent", "codex", "claude"]);
});

test("G-356 without --write-latest does not write --latest-file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "g356-nolatest-"));
	const dest = join(dir, "channel-probe-latest.json");
	const result = runProbe(["--json", "--channels", "definitely-not-a-cli-xyz", "--latest-file", dest]);
	assert.equal(result.error, undefined);
	assert.equal(existsSync(dest), false, "absent --write-latest must not create the archive");
});
