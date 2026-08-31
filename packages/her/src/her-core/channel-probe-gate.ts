/**
 * G-356 — spawn-layer freshness gate for external CLI workers.
 * Reads ops/channel-probe-latest.json; never launches the probe itself.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/her/src/her-core → samantha repo root (same hop as worker-profile / deer-samantha-agent). */
export const SAMANTHA_REPO_ROOT = resolve(HERE, "../../../..");
export const CHANNEL_PROBE_LATEST_RELATIVE = join("ops", "channel-probe-latest.json");
export const CHANNEL_PROBE_REMEDY = "node packages/her/scripts/probe-worker-channels.mjs --write-latest";
export const EXTERNAL_CLI_SET = new Set(["grok", "codex", "claude", "cursor-agent"]);

export type ChannelProbeRow = {
	name: string;
	alive: boolean;
	version: string | null;
	error: string | null;
	quota: string;
};

export type ChannelProbeLatest = {
	at: string;
	channels: ChannelProbeRow[];
};

export function channelProbeLatestPath(repoRoot: string): string {
	return join(repoRoot, CHANNEL_PROBE_LATEST_RELATIVE);
}

function remedySuffix(): string {
	return `补救: ${CHANNEL_PROBE_REMEDY}`;
}

function throwMissing(detail: string): never {
	throw new Error(`channel probe 缺档: ${detail}. ${remedySuffix()}`);
}

export function assertFreshExternalCliProbe(opts: {
	cliName: string;
	maxAgeHours: number;
	repoRoot: string;
	now?: Date;
}): void {
	if (!EXTERNAL_CLI_SET.has(opts.cliName)) return;
	if (!(opts.maxAgeHours > 0)) return;

	const path = channelProbeLatestPath(opts.repoRoot);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			throwMissing(`missing ${CHANNEL_PROBE_LATEST_RELATIVE}`);
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throwMissing(`${CHANNEL_PROBE_LATEST_RELATIVE} 无法解析`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throwMissing(`${CHANNEL_PROBE_LATEST_RELATIVE} 无法解析`);
	}
	const record = parsed as { at?: unknown; channels?: unknown };
	if (typeof record.at !== "string" || !Array.isArray(record.channels)) {
		throwMissing(`${CHANNEL_PROBE_LATEST_RELATIVE} 无法解析`);
	}
	const atMs = Date.parse(record.at);
	if (!Number.isFinite(atMs)) {
		throwMissing(`${CHANNEL_PROBE_LATEST_RELATIVE} 无法解析`);
	}

	const nowMs = (opts.now ?? new Date()).getTime();
	const ageHours = Math.max(0, nowMs - atMs) / 3_600_000;
	if (ageHours > opts.maxAgeHours) {
		const n = Math.max(1, Math.round(ageHours));
		throw new Error(
			`channel probe 过期 ${n} 小时: ${CHANNEL_PROBE_LATEST_RELATIVE} (max ${opts.maxAgeHours}h). ${remedySuffix()}`,
		);
	}

	const row = record.channels.find(
		(item): item is ChannelProbeRow =>
			Boolean(item) && typeof item === "object" && (item as { name?: unknown }).name === opts.cliName,
	);
	if (!row || row.alive !== true) {
		throw new Error(`channel probe 该通道 dead: ${opts.cliName}. ${remedySuffix()}`);
	}
}
