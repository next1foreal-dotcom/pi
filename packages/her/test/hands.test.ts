import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateHandsPolicy,
	type HandsActionKind,
	type HandsResolvedConfig,
	resolveHandsConfig,
} from "../src/hands/policy.ts";
import { DEFAULT_CONFIG, type HerConfig } from "../src/her-core/config.ts";

function hands(overrides: Partial<HerConfig["hands"]> = {}): HandsResolvedConfig {
	return resolveHandsConfig({ ...DEFAULT_CONFIG.hands, enabled: true, desktopEnabled: true, ...overrides });
}

function decision(action: HandsActionKind, targetProcess: string, config = hands()) {
	return evaluateHandsPolicy({ surface: "desktop", action, targetProcess, config });
}

test("T1 empty whitelist denies every desktop target", () => {
	assert.deepEqual(decision("click", "notepad.exe", hands({ desktopAllowedApps: "" })), {
		allow: false,
		reason: "not in whitelist: notepad.exe",
	});
});

test("T2 whitelisted process allows click", () => {
	assert.deepEqual(decision("click", "notepad.exe", hands({ desktopAllowedApps: "notepad.exe" })), { allow: true });
});

test("T3 process matching trims whitespace and ignores case", () => {
	assert.deepEqual(decision("click", " Notepad.EXE ", hands({ desktopAllowedApps: " notepad.exe " })), {
		allow: true,
	});
});

test("T4 hard-denied process stays denied even when configured as allowed", () => {
	const result = decision("click", "chrome.exe", hands({ desktopAllowedApps: "chrome.exe" }));

	assert.equal(result.allow, false);
	if (!result.allow) assert.match(result.reason, /hard-denied process: chrome\.exe/);
});

test("T5 tier 1 denies write actions", () => {
	const result = decision("type_text", "notepad.exe", hands({ desktopAllowedApps: "notepad.exe", desktopTier: 1 }));

	assert.equal(result.allow, false);
	if (!result.allow) assert.match(result.reason, /tier 2/);
});

test("T6 tier 2 allows write actions in whitelist", () => {
	assert.deepEqual(
		decision("type_text", "notepad.exe", hands({ desktopAllowedApps: "notepad.exe", desktopTier: 2 })),
		{
			allow: true,
		},
	);
});

test("T7 disabled config denies all actions", () => {
	assert.deepEqual(
		decision("click", "notepad.exe", hands({ enabled: false, desktopAllowedApps: "notepad.exe", desktopTier: 2 })),
		{ allow: false, reason: "hands disabled" },
	);
	assert.deepEqual(
		decision(
			"type_text",
			"notepad.exe",
			hands({ desktopEnabled: false, desktopAllowedApps: "notepad.exe", desktopTier: 2 }),
		),
		{ allow: false, reason: "hands disabled" },
	);
});

test("T8 snapshot also requires whitelist", () => {
	assert.deepEqual(decision("snapshot", "calculatorapp.exe", hands({ desktopAllowedApps: "notepad.exe" })), {
		allow: false,
		reason: "not in whitelist: calculatorapp.exe",
	});
});
