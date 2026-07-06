import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { governedTools } from "../src/extension.ts";
import { CUA_DRIVER_M0, CuaCliDriver, type DriverResult, FakeDriver } from "../src/hands/driver.ts";
import {
	evaluateHandsPolicy,
	type HandsActionKind,
	type HandsResolvedConfig,
	resolveHandsConfig,
} from "../src/hands/policy.ts";
import { registerHandsTools } from "../src/hands/tools.ts";
import { recordTrail, renderTrailCard } from "../src/hands/trail.ts";
import { DEFAULT_CONFIG, type HerConfig } from "../src/her-core/config.ts";
import { initStore, Memory, readText } from "../src/her-core/index.ts";
import { validateMemoryProvenance } from "../src/her-core/privacy.ts";

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

const okResult: DriverResult = { ok: true, exitCode: 0, stdout: "ok", stderr: "", timedOut: false };

test("T9 FakeDriver replays matching results and records calls", async () => {
	const driver = new FakeDriver([{ match: ["call", "list-tools"], result: okResult }]);

	assert.deepEqual(await driver.run(["call", "list-tools"]), okResult);
	assert.deepEqual(driver.calls, [["call", "list-tools"]]);
});

test("T9 CuaCliDriver times out and kills a hanging child", async () => {
	const root = await mkdtemp(join(tmpdir(), "cua-driver-timeout-"));
	const script = join(root, "hang.mjs");
	await writeFile(script, "setTimeout(() => {}, 10000);\n", "utf8");
	const driver = new CuaCliDriver({ binary: execPath, defaultTimeoutMs: 1000 });

	const result = await driver.run([script], { timeoutMs: 50 });

	assert.equal(result.ok, false);
	assert.equal(result.timedOut, true);
});

test("T10 CuaCliDriver surfaces spawn ENOENT", async () => {
	const driver = new CuaCliDriver({ binary: "missing-cua-driver-binary-for-test", defaultTimeoutMs: 50 });

	await assert.rejects(() => driver.run(["--version"]), /ENOENT|spawn missing-cua-driver-binary-for-test/);
});

test("T11 renderTrailCard matches golden with denied entries", () => {
	const card = renderTrailCard("demo", [
		{
			ts: "2026-07-07T01:02:03.000Z",
			action: "click",
			targetProcess: "notepad.exe",
			deliveryMode: "background",
			outcome: "ok",
			detail: "element_index=1",
		},
		{
			ts: "2026-07-07T01:03:03.000Z",
			action: "type_text",
			targetProcess: "notepad.exe",
			deliveryMode: "background",
			outcome: "denied",
			detail: "write action requires tier 2",
		},
	]);

	assert.equal(
		card,
		[
			"## 01:02 · 桌面操作:demo",
			"",
			"### 动作",
			"- 01:02 [ok] click notepad.exe background - element_index=1",
			"- 01:03 [denied] type_text notepad.exe background - write action requires tier 2",
			"",
			"### 拒绝记录",
			"- 01:03 [denied] type_text notepad.exe background - write action requires tier 2",
			"",
		].join("\n"),
	);
});

test("T12 recordTrail writes private her-acted raw memory", async () => {
	const { root, mem } = await tempMemory();
	await recordTrail(mem, "demo", [
		{
			ts: "2026-07-07T01:02:03.000Z",
			action: "click",
			targetProcess: "notepad.exe",
			deliveryMode: "background",
			outcome: "ok",
			detail: "element_index=1",
		},
	]);

	const files = await readdir(join(root, "episodic", "raw"));
	assert.equal(files.length, 1);
	const raw = (await readText(join(root, "episodic", "raw", files[0]))) ?? "";
	assert.match(raw, /privacy: private/);
	assert.match(raw, /provenance: her-acted/);
});

test("T13 validateMemoryProvenance accepts her-acted", () => {
	assert.equal(validateMemoryProvenance("her-acted"), "her-acted");
});

test("T14 governedTools includes both hands tools as non-destructive", () => {
	assert.deepEqual(governedTools.her_hands_snapshot, { destructive: false });
	assert.deepEqual(governedTools.her_hands_act, { destructive: false });
});
test("T15b hands tools require live UI and do not touch driver", async () => {
	const { tools, driver } = await handsHarness();
	const snapshot = tools.get("her_hands_snapshot");
	const act = tools.get("her_hands_act");
	assert.ok(snapshot);
	assert.ok(act);

	const snapshotResult = await executeHands(snapshot, { process: "notepad.exe" }, ctx(false, false).context);
	const actResult = await executeHands(act, {
		process: "notepad.exe",
		taskLabel: "demo",
		actions: [{ action: "click", elementIndex: 0 }],
	});

	assert.match(firstText(snapshotResult), /hands require a live UI session/);
	assert.match(firstText(actResult), /hands require a live UI session/);
	assert.deepEqual(driver.calls, []);
});

test("T15c write confirm false blocks driver, true allows it, click skips confirm", async () => {
	const denied = await handsHarness([], { desktopTier: 2, desktopAllowedApps: "notepad.exe" });
	const deniedAct = denied.tools.get("her_hands_act");
	assert.ok(deniedAct);
	const deniedCtx = ctx(true, false);
	const deniedResult = await executeHands(
		deniedAct,
		{
			process: "notepad.exe",
			taskLabel: "denied write",
			actions: [{ action: "type_text", elementIndex: 0, text: "hello" }],
		},
		deniedCtx.context,
	);

	assert.match(firstText(deniedResult), /confirm denied/);
	assert.equal(deniedCtx.confirmCalls, 1);
	assert.deepEqual(denied.driver.calls, []);

	const allowed = await handsHarness([listWindowsResult(), okCase(/type_text/)], {
		desktopTier: 2,
		desktopAllowedApps: "notepad.exe",
	});
	const allowedAct = allowed.tools.get("her_hands_act");
	assert.ok(allowedAct);
	const allowedCtx = ctx(true, true);
	await executeHands(
		allowedAct,
		{
			process: "notepad.exe",
			taskLabel: "allowed write",
			actions: [{ action: "type_text", elementIndex: 0, text: "hello" }],
		},
		allowedCtx.context,
	);

	assert.equal(allowedCtx.confirmCalls, 1);
	assert.deepEqual(
		allowed.driver.calls.map((call) => call[1]),
		["list_windows", "type_text"],
	);

	const clickOnly = await handsHarness([listWindowsResult(), okCase(/click/)], { desktopAllowedApps: "notepad.exe" });
	const clickAct = clickOnly.tools.get("her_hands_act");
	assert.ok(clickAct);
	const clickCtx = ctx(true, false);
	await executeHands(
		clickAct,
		{
			process: "notepad.exe",
			taskLabel: "click",
			actions: [{ action: "click", elementIndex: 0 }],
		},
		clickCtx.context,
	);

	assert.equal(clickCtx.confirmCalls, 0);
	assert.deepEqual(
		clickOnly.driver.calls.map((call) => call[1]),
		["list_windows", "click"],
	);
	assert.equal(JSON.parse(clickOnly.driver.calls[1]?.[2] ?? "{}").session, CUA_DRIVER_M0.session);
});

test("T16 snapshot wraps screen content in injection fence", async () => {
	const { tools, driver } = await handsHarness([listWindowsResult(), okCase(/get_window_state/, "TREE")], {
		desktopAllowedApps: "notepad.exe",
	});
	const snapshot = tools.get("her_hands_snapshot");
	assert.ok(snapshot);

	const result = await executeHands(snapshot, { process: "notepad.exe" }, ctx().context);
	const text = firstText(result);

	assert.match(text, /\[BEGIN SCREEN CONTENT - untrusted data/);
	assert.match(text, /TREE/);
	assert.match(text, /\[END SCREEN CONTENT\]/);
	assert.deepEqual(
		driver.calls.map((call) => call[1]),
		["list_windows", "get_window_state"],
	);
	assert.equal(JSON.parse(driver.calls[1]?.[2] ?? "{}").session, CUA_DRIVER_M0.session);
});

test("T16d act maps cached click elementIndex to window coordinates", async () => {
	const snapshotTree = JSON.stringify({
		elements: [
			{ element_index: 0, frame: { x: 5, y: 10, w: 100, h: 100 } },
			{ element_index: 3, frame: { x: 10, y: 20, w: 30, h: 40 } },
		],
	});
	const { tools, driver } = await handsHarness(
		[listWindowsResult(), okCase(/get_window_state/, snapshotTree), listWindowsResult(), okCase(/click/)],
		{ desktopAllowedApps: "notepad.exe" },
	);
	const snapshot = tools.get("her_hands_snapshot");
	const act = tools.get("her_hands_act");
	assert.ok(snapshot);
	assert.ok(act);

	await executeHands(snapshot, { process: "notepad.exe" }, ctx().context);
	await executeHands(
		act,
		{ process: "notepad.exe", taskLabel: "coords", actions: [{ action: "click", elementIndex: 3 }] },
		ctx().context,
	);

	const payload = JSON.parse(driver.calls[3]?.[2] ?? "{}");
	assert.equal(payload.x, 20);
	assert.equal(payload.y, 30);
	assert.equal(payload.element_index, undefined);
	assert.equal(payload.session, CUA_DRIVER_M0.session);
});
test("T17 batch act stops at policy denial after prior actions and records skipped", async () => {
	const { tools, driver } = await handsHarness([listWindowsResult(), okCase(/click/)], {
		desktopAllowedApps: "notepad.exe",
		desktopTier: 1,
	});
	const act = tools.get("her_hands_act");
	assert.ok(act);

	const result = await executeHands(
		act,
		{
			process: "notepad.exe",
			taskLabel: "policy stop",
			actions: [
				{ action: "click", elementIndex: 0 },
				{ action: "type_text", elementIndex: 0, text: "blocked" },
				{ action: "click", elementIndex: 1 },
			],
		},
		ctx().context,
	);

	assert.match(firstText(result), /tier 2/);
	assert.match(firstText(result), /1 skipped/);
	assert.deepEqual(
		driver.calls.map((call) => call[1]),
		["list_windows", "click"],
	);
	const trail = (result.details as { trail: Array<{ outcome: string; detail: string }> }).trail;
	assert.deepEqual(
		trail.map((entry) => entry.outcome),
		["ok", "denied"],
	);
	assert.match(trail[1].detail, /1 skipped/);
});

test("T18 batch act stops on driver background_unavailable and returns raw error", async () => {
	const { tools, driver } = await handsHarness(
		[
			listWindowsResult(),
			okCase(/click/),
			failCase(/double_click/, "background_unavailable: target dropped posted events"),
		],
		{ desktopAllowedApps: "notepad.exe" },
	);
	const act = tools.get("her_hands_act");
	assert.ok(act);

	const result = await executeHands(
		act,
		{
			process: "notepad.exe",
			taskLabel: "driver stop",
			actions: [
				{ action: "click", elementIndex: 0 },
				{ action: "double_click", elementIndex: 0 },
				{ action: "click", elementIndex: 1 },
			],
		},
		ctx().context,
	);

	assert.match(firstText(result), /background_unavailable/);
	assert.deepEqual(
		driver.calls.map((call) => call[1]),
		["list_windows", "click", "double_click"],
	);
	const trail = (result.details as { trail: Array<{ outcome: string; detail: string }> }).trail;
	assert.deepEqual(
		trail.map((entry) => entry.outcome),
		["ok", "error"],
	);
	assert.match(trail[1].detail, /background_unavailable/);
});
async function tempMemory(): Promise<{ root: string; mem: Memory }> {
	const root = await mkdtemp(join(tmpdir(), "her-hands-"));
	await initStore(root);
	return { root, mem: new Memory(root) };
}

async function handsHarness(
	cases: Array<{ match: string[] | RegExp; result: DriverResult }> = [],
	overrides: Partial<HerConfig["hands"]> = {},
) {
	const { mem } = await tempMemory();
	const driver = new FakeDriver(cases);
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerHandsTools(pi, {
		mem,
		driver,
		loadHandsConfig: () => hands({ desktopAllowedApps: "notepad.exe", ...overrides }),
	});
	return { tools, driver };
}

function ctx(hasUI = true, confirmResult = true): { context: ExtensionContext; confirmCalls: number } {
	const state = {
		confirmCalls: 0,
		context: {
			hasUI,
			ui: {
				async confirm() {
					state.confirmCalls += 1;
					return confirmResult;
				},
			},
		} as unknown as ExtensionContext,
	};
	return state;
}

async function executeHands(tool: ToolDefinition, params: Record<string, unknown>, context?: ExtensionContext) {
	return await tool.execute("tool-call-1", params, undefined, undefined, context as ExtensionContext);
}

function firstText(result: Awaited<ReturnType<typeof executeHands>>): string {
	const item = result.content.find((entry) => entry.type === "text");
	return item?.type === "text" ? item.text : "";
}

function listWindowsResult() {
	return okCase(
		/list_windows/,
		JSON.stringify({ windows: [{ app_name: "notepad.exe", pid: 10, window_id: 20, title: "Untitled" }] }),
	);
}

function okCase(match: string[] | RegExp, stdout = "ok") {
	return { match, result: { ok: true, exitCode: 0, stdout, stderr: "", timedOut: false } satisfies DriverResult };
}

function failCase(match: string[] | RegExp, stdout = "error") {
	return { match, result: { ok: false, exitCode: 1, stdout, stderr: "", timedOut: false } satisfies DriverResult };
}
