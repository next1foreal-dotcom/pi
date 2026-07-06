import type { HerConfig } from "../her-core/config.ts";

export type HandsSurface = "desktop" | "web" | "sandbox";
export type HandsActionKind =
	| "snapshot"
	| "click"
	| "double_click"
	| "right_click"
	| "scroll"
	| "type_text"
	| "press_key"
	| "hotkey"
	| "drag";

export const WRITE_ACTIONS: readonly HandsActionKind[] = ["type_text", "press_key", "hotkey", "drag"];
export const HARD_DENIED_PROCESSES: readonly string[] = [
	"chrome.exe",
	"msedge.exe",
	"firefox.exe",
	"brave.exe",
	"arc.exe",
	"1password.exe",
	"bitwarden.exe",
	"keepass.exe",
	"keepassxc.exe",
	"wechat.exe",
	"weixin.exe",
	"telegram.exe",
	"qq.exe",
	"discord.exe",
	"slack.exe",
	"cmd.exe",
	"powershell.exe",
	"pwsh.exe",
	"windowsterminal.exe",
	"wt.exe",
	"conhost.exe",
	"mstsc.exe",
];

export interface HandsResolvedConfig {
	enabled: boolean;
	desktopEnabled: boolean;
	desktopAllowedApps: readonly string[];
	desktopDeniedApps: readonly string[];
	desktopTier: number;
	desktopMaxActionsPerTask: number;
	desktopActionTimeoutS: number;
	desktopDriverBinary: string;
}

export interface HandsPolicyInput {
	surface: HandsSurface;
	action: HandsActionKind;
	targetProcess: string;
	config: HandsResolvedConfig;
}

export type HandsPolicyDecision = { allow: true } | { allow: false; reason: string };

export function resolveHandsConfig(config: HerConfig["hands"]): HandsResolvedConfig {
	return {
		enabled: config.enabled,
		desktopEnabled: config.desktopEnabled,
		desktopAllowedApps: splitProcessList(config.desktopAllowedApps),
		desktopDeniedApps: splitProcessList(config.desktopDeniedApps),
		desktopTier: config.desktopTier,
		desktopMaxActionsPerTask: config.desktopMaxActionsPerTask,
		desktopActionTimeoutS: config.desktopActionTimeoutS,
		desktopDriverBinary: config.desktopDriverBinary,
	};
}

export function evaluateHandsPolicy(input: HandsPolicyInput): HandsPolicyDecision {
	if (input.surface !== "desktop") return { allow: false, reason: `unsupported surface: ${input.surface}` };
	if (!input.config.enabled || !input.config.desktopEnabled) return { allow: false, reason: "hands disabled" };

	const targetProcess = normalizeProcess(input.targetProcess);
	const hardDenied = new Set(HARD_DENIED_PROCESSES);
	if (hardDenied.has(targetProcess)) return { allow: false, reason: `hard-denied process: ${targetProcess}` };
	if (input.config.desktopDeniedApps.includes(targetProcess)) {
		return { allow: false, reason: `denied process: ${targetProcess}` };
	}
	if (!input.config.desktopAllowedApps.includes(targetProcess)) {
		return { allow: false, reason: `not in whitelist: ${targetProcess}` };
	}
	if (WRITE_ACTIONS.includes(input.action) && input.config.desktopTier < 2) {
		return { allow: false, reason: "write action requires tier 2 (Fei per-use approval)" };
	}
	return { allow: true };
}

function splitProcessList(value: string): string[] {
	return value
		.split(",")
		.map((item) => normalizeProcess(item))
		.filter(Boolean);
}

function normalizeProcess(value: string): string {
	return value.trim().toLowerCase();
}
