/**
 * G-122/G-124 — tasks + publish config slices (appendix G).
 * Missing keys fall back to defaults (compat WARN via returned warnings).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type HerConfig, loadConfig } from "./config.ts";

export type TasksConfig = {
	defaultWorker: string;
	maxConcurrent: number;
	defaultTimeoutMinutes: number;
	heartbeatSeconds: number;
	staleMultiplier: number;
	launchGraceSeconds: number;
	budgetCap: number;
	budgetDailyCap: number;
	logCapBytes: number;
	logHeadBytes: number;
	logTailBytes: number;
	retentionDays: number;
	reconcileLeaseSeconds: number;
	maxRetries: number;
	retryOn: string[];
	telegramNotify: boolean;
};

export type PublishConfig = {
	bind: string;
	port: number;
	inlineThresholdBytes: number;
	maxAssetBytes: number;
};

export const DEFAULT_TASKS_CONFIG: TasksConfig = {
	defaultWorker: "cheap_worker",
	maxConcurrent: 3,
	defaultTimeoutMinutes: 60,
	heartbeatSeconds: 15,
	staleMultiplier: 3,
	launchGraceSeconds: 60,
	budgetCap: 5,
	budgetDailyCap: 20,
	logCapBytes: 2_097_152,
	logHeadBytes: 262_144,
	logTailBytes: 786_432,
	retentionDays: 30,
	reconcileLeaseSeconds: 30,
	maxRetries: 2,
	retryOn: ["orphaned", "never_started"],
	telegramNotify: true,
};

export const DEFAULT_PUBLISH_CONFIG: PublishConfig = {
	bind: "127.0.0.1",
	port: 8788,
	inlineThresholdBytes: 524_288,
	maxAssetBytes: 5_242_880,
};

export type HerRuntimeConfig = HerConfig & {
	tasks: TasksConfig;
	publish: PublishConfig;
	warnings: string[];
};

export function loadRuntimeConfig(memoryRoot: string): HerRuntimeConfig {
	const path = join(memoryRoot, ".her", "config.yaml");
	const base = loadConfig(path);
	const raw = readOptionalSections(path);
	const warnings: string[] = [];
	if (!raw.tasks) warnings.push("config.tasks missing — using defaults");
	if (!raw.publish) warnings.push("config.publish missing — using defaults");
	const tasks = { ...DEFAULT_TASKS_CONFIG, ...(raw.tasks ?? {}) };
	if (tasks.staleMultiplier < 3) {
		warnings.push("tasks.stale_multiplier < 3 forced to 3");
		tasks.staleMultiplier = 3;
	}
	const publish = { ...DEFAULT_PUBLISH_CONFIG, ...(raw.publish ?? {}) };
	return { ...base, tasks, publish, warnings };
}

function readOptionalSections(path: string): {
	tasks?: Partial<TasksConfig>;
	publish?: Partial<PublishConfig>;
} {
	try {
		return parseTasksPublish(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

/** Exported for tests — parse tasks/publish from yaml-ish text. */
export function parseTasksPublish(text: string): {
	tasks?: Partial<TasksConfig>;
	publish?: Partial<PublishConfig>;
} {
	const sections: Record<string, Record<string, unknown>> = {};
	let section: string | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.replace(/\s+#.*$/, "");
		if (!line.trim()) continue;
		const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (top && !rawLine.startsWith(" ") && !rawLine.startsWith("\t")) {
			section = top[1];
			sections[section] = {};
			continue;
		}
		const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!nested || !section) continue;
		const key = camel(nested[1]);
		const val = nested[2].trim();
		if (val.startsWith("[") && val.endsWith("]")) {
			sections[section][key] = val
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
		} else if (val === "true" || val === "false") {
			sections[section][key] = val === "true";
		} else if (/^-?\d+(?:\.\d+)?$/.test(val)) {
			sections[section][key] = Number(val);
		} else {
			sections[section][key] = val.replace(/^["']|["']$/g, "");
		}
	}
	return {
		...(sections.tasks ? { tasks: sections.tasks as Partial<TasksConfig> } : {}),
		...(sections.publish ? { publish: sections.publish as Partial<PublishConfig> } : {}),
	};
}

function camel(text: string): string {
	return text.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}
