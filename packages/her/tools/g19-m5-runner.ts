import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../../coding-agent/src/core/extensions/types.ts";
import { DEFAULT_CONFIG, loadConfig, renderConfig } from "../src/her-core/config.ts";
import { initStore, Memory, readText } from "../src/her-core/index.ts";
import { CuaCliDriver } from "../src/hands/driver.ts";
import { resolveHandsConfig } from "../src/hands/policy.ts";
import { registerHandsTools } from "../src/hands/tools.ts";

const CALCULATOR_TITLE = "\u8ba1\u7b97\u5668";
const DISPLAY_0 = "\u663e\u793a\u4e3a 0";
const DISPLAY_7 = "\u663e\u793a\u4e3a 7";
const DRIVER = "C:/Users/Admin/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe";

async function main() {
	const root = `D:/@Her/g19-m5-store-${Date.now()}`;
	await initStore(root);
	await mkdir(join(root, ".her"), { recursive: true });
	const config = {
		...DEFAULT_CONFIG,
		hands: {
			...DEFAULT_CONFIG.hands,
			enabled: true,
			desktopEnabled: true,
			desktopAllowedApps: "applicationframehost.exe,notepad.exe",
			desktopTier: 1,
			desktopDriverBinary: DRIVER,
		},
	};
	await writeFile(join(root, ".her", "config.yaml"), renderConfig(config), "utf8");
	const mem = new Memory(root);
	const tools = new Map<string, ToolDefinition>();
	const pi = { registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
	const driver = new CuaCliDriver({ binary: config.hands.desktopDriverBinary, defaultTimeoutMs: 30000 });
	registerHandsTools(pi, { mem, driver, loadHandsConfig: () => resolveHandsConfig(loadConfig(join(root, ".her", "config.yaml")).hands) });
	const ctx = { hasUI: true, ui: { async confirm() { return true; } } } as unknown as ExtensionContext;
	const snapshot = tools.get("her_hands_snapshot");
	const act = tools.get("her_hands_act");
	if (!snapshot || !act) throw new Error("hands tools not registered");

	function text(result: any): string {
		return result.content.find((item: any) => item.type === "text")?.text ?? "";
	}
	async function execute(tool: ToolDefinition, params: Record<string, unknown>) {
		return await tool.execute("m5", params, undefined, undefined, ctx);
	}
	async function topWindow() {
		const result = await driver.run(["call", "list_windows", "{}"]).catch((error) => ({ stdout: "{}", error }));
		const parsed = JSON.parse(result.stdout || "{}");
		const sorted = [...(parsed.windows ?? [])].sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));
		return { title: sorted[0]?.title, app: sorted[0]?.app_name, window_id: sorted[0]?.window_id };
	}

	const topBefore = await topWindow();
	const totalStart = performance.now();
	const snapshotStart = performance.now();
	const snapshotResult = await execute(snapshot, { process: "ApplicationFrameHost.exe", windowTitleHint: CALCULATOR_TITLE });
	const snapshotMs = performance.now() - snapshotStart;
	const snapshotText = text(snapshotResult);
	const snapshotWindow = (snapshotResult as any).details?.window;
	if (!snapshotWindow) throw new Error(`snapshot did not return a window: ${snapshotText}`);
	const needsClear = !snapshotText.includes(DISPLAY_0);
	const actions = [
		...(needsClear ? [{ action: "click", elementIndex: 14 }] : []),
		{ action: "click", elementIndex: 27 },
		{ action: "click", elementIndex: 22 },
		{ action: "click", elementIndex: 28 },
		{ action: "click", elementIndex: 23 },
	];
	const actStart = performance.now();
	const actResult = await execute(act, {
		process: "ApplicationFrameHost.exe",
		windowTitleHint: CALCULATOR_TITLE,
		taskLabel: "calculator 3+4=",
		actions,
	});
	const actMs = performance.now() - actStart;
	const totalMs = performance.now() - totalStart;
	const verify = await driver.run(["call", "get_window_state", JSON.stringify({ pid: snapshotWindow.pid, window_id: snapshotWindow.window_id, include_screenshot: false, max_elements: 80 })]);
	const topAfter = await topWindow();
	const rawFiles = await readdir(join(root, "episodic", "raw"));
	const trailCards = [];
	for (const file of rawFiles) trailCards.push({ file, text: await readText(join(root, "episodic", "raw", file)) });
	await writeFile(join(root, ".her", "config.yaml"), renderConfig(DEFAULT_CONFIG), "utf8");
	console.log(JSON.stringify({
		store: root,
		process: "ApplicationFrameHost.exe",
		windowTitle: CALCULATOR_TITLE,
		windowId: snapshotWindow.window_id,
		pid: snapshotWindow.pid,
		topBefore,
		topAfter,
		snapshotMs: Math.round(snapshotMs),
		snapshotChars: snapshotText.length,
		actMs: Math.round(actMs),
		actionCount: actions.length,
		avgActionMs: Math.round(actMs / actions.length),
		totalSeconds: Number((totalMs / 1000).toFixed(2)),
		toolRounds: 2,
		needsClear,
		actText: text(actResult),
		verifyHas7: verify.stdout.includes(DISPLAY_7),
		verifyExcerpt: (verify.stdout.match(/\u663e\u793a\u4e3a 7|\u663e\u793a\u4e3a 0|\u663e\u793a\u4e3a \d+/u)?.[0] ?? "not found"),
		trailCards,
	}, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});