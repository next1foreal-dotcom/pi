// L2 road test for the desktop hands: open Notepad, type one line, read it back, verify by probe.
//
//   node --import tsx packages/her/tools/hands-l2-drill.ts            # dry run, touches nothing
//   node --import tsx packages/her/tools/hands-l2-drill.ts --live     # real desktop, Fei must be present
//   HER_HANDS_DRILL_CONFIRM=1 node --import tsx ... --live            # also answers the write-confirm dialog
//
// The dry run reads config and checks preconditions only: no window opens, no key is pressed,
// no agent is spawned. --live drives a real rpc session, so the mouse and keyboard are hers for
// the duration. Without HER_HANDS_DRILL_CONFIRM=1 the drill answers "no" to her confirm dialog,
// which exercises the gate but leaves nothing typed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CuaCliDriver } from "../src/hands/driver.ts";
import { loadConfig } from "../src/her-core/config.ts";
import { type HandsResolvedConfig, resolveHandsConfig } from "../src/hands/policy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const samanthaRoot = resolve(here, "..", "..", "..");
const memoryDir = process.env.HER_MEMORY_DIR ?? resolve(samanthaRoot, "..", "her-memory");
const configPath = join(memoryDir, ".her", "config.yaml");
const cliPath = join(samanthaRoot, "packages", "coding-agent", "dist", "cli.js");
const model = process.env.HER_HANDS_DRILL_MODEL ?? "deepseek/deepseek-v4-flash";
const autoConfirm = process.env.HER_HANDS_DRILL_CONFIRM === "1";
const live = process.argv.includes("--live");
const taskLabel = "hands L2 road test";
const drillText = "Her hands L2 drill 2026-08-03";
const promptTimeoutMs = 300_000;
const finalTextRequestId = "drill-final-text";

interface DriverWindow {
	pid: number;
	window_id: number;
	app_name?: string;
	title?: string;
}

async function main(): Promise<void> {
	const config = resolveHandsConfig(loadConfig(configPath).hands);
	const preflight = checkPreconditions(config);
	report("preconditions", { configPath, memoryDir, model, autoConfirm, ...preflight });
	if (preflight.blockers.length > 0) {
		console.error(`blocked: ${preflight.blockers.join(" | ")}`);
		process.exitCode = 1;
		return;
	}
	if (!live) {
		report("dry-run", {
			wouldLaunch: "notepad.exe",
			wouldPrompt: buildPrompt("<detected at run time>", "<detected at run time>"),
			note: "nothing opened, nothing typed, no agent spawned — pass --live when Fei is at the machine",
		});
		return;
	}

	const driver = new CuaCliDriver({
		binary: config.desktopDriverBinary,
		defaultTimeoutMs: config.desktopActionTimeoutS * 1000,
	});
	spawn("notepad.exe", { detached: true, stdio: "ignore" }).unref();
	await delay(2500);

	const target = await findNotepadWindow(driver);
	if (!target) throw new Error("no Notepad window found — is it open? (see the window list above)");
	const appName = (target.app_name ?? "").toLowerCase();
	if (!config.desktopAllowedApps.includes(appName)) {
		throw new Error(`Notepad reports app_name=${appName}, which is not in desktop_allowed_apps — fix config first`);
	}
	report("target", target);

	const before = await readWindowText(driver, target);
	const session = await runAgentSession(buildPrompt(target.app_name ?? "notepad.exe", target.title ?? ""));
	const after = await readWindowText(driver, target);

	report("verdict", {
		typedTextFoundOnScreen: after.includes(drillText),
		screenGrewBy: after.length - before.length,
		agentSawHandsTools: session.handsToolLines.length,
		agentFinalText: session.finalText,
		trailCard: await newestTrailCard(),
		log: session.logPath,
		leftOpen: "an unsaved Notepad window is still on the desktop — close it yourself, the drill never saves",
	});
}

function checkPreconditions(config: HandsResolvedConfig) {
	const blockers: string[] = [];
	if (!config.enabled || !config.desktopEnabled) blockers.push("hands disabled in config");
	if (config.desktopTier < 2) blockers.push(`desktop_tier=${config.desktopTier}, need 2 to type`);
	if (!config.desktopAllowedApps.includes("notepad.exe")) blockers.push("notepad.exe missing from desktop_allowed_apps");
	if (!existsSync(config.desktopDriverBinary)) blockers.push(`driver binary missing: ${config.desktopDriverBinary}`);
	if (live && !existsSync(cliPath)) blockers.push(`cli not built: ${cliPath} (npm run build:offline)`);
	return {
		allowedApps: config.desktopAllowedApps,
		tier: config.desktopTier,
		maxActionsPerTask: config.desktopMaxActionsPerTask,
		driverBinary: config.desktopDriverBinary,
		blockers,
	};
}

function buildPrompt(appName: string, windowTitle: string): string {
	return [
		`记事本已经开着（进程 ${appName}，窗口标题「${windowTitle}」）。用你的桌面手完成这件事，每一步都如实汇报：`,
		"1. her_hands_snapshot 读这个窗口，告诉我文本编辑区是哪个元素、现在里面有什么",
		`2. her_hands_act 在文本编辑区里打进这一行，一字不差：${drillText}`,
		"3. 再 her_hands_snapshot 一次，把你这次读回来的文本原样报给我",
		`taskLabel 用「${taskLabel}」。任何一步被拒或失败，原样报错并停下，不要重试、不要换别的窗口。`,
	].join("\n");
}

async function runAgentSession(prompt: string): Promise<{ finalText: string; handsToolLines: string[]; logPath: string }> {
	// Out of the repo on purpose: a drill artifact is not repo content.
	const logPath = join(tmpdir(), `hands-l2-drill-${Date.now()}.log`);
	const lines: string[] = [];
	const handsToolLines: string[] = [];
	let finalText = "";
	const child = spawn(process.execPath, [cliPath, "--mode", "rpc", "--no-session", "--model", model], {
		cwd: samanthaRoot,
		env: { ...process.env, NODE_USE_ENV_PROXY: "1" },
	});

	const finished = new Promise<void>((resolveDone) => {
		let buffer = "";
		let promptSent = false;
		let askedForText = false;
		let settled = false;
		const stop = (why: string) => {
			if (settled) return;
			settled = true;
			lines.push(`[stop] ${why}`);
			child.kill();
			resolveDone();
		};
		const timer = setTimeout(() => stop("global timeout"), promptTimeoutMs);
		timer.unref();

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line.trim()) continue;
				lines.push(line);
				if (line.includes("her_hands")) handsToolLines.push(line);
				answerConfirm(child, line, lines);
				const text = extractAssistantText(line);
				if (text !== undefined) finalText = text;
				if (!promptSent) {
					promptSent = true;
					setTimeout(() => child.stdin.write(`${JSON.stringify({ id: "drill-1", type: "prompt", message: prompt })}\n`), 1500);
				}
				if (/"type"\s*:\s*"agent_end"/.test(line) && promptSent && !askedForText) {
					askedForText = true;
					child.stdin.write(`${JSON.stringify({ id: finalTextRequestId, type: "get_last_assistant_text" })}\n`);
					setTimeout(() => stop("agent_end"), 5000);
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => lines.push(`[stderr] ${chunk.trim()}`));
		child.on("exit", (code: number | null) => stop(`child exit ${code}`));
	});

	await finished;
	await writeLog(logPath, lines);
	return { finalText, handsToolLines, logPath };
}

function answerConfirm(child: ReturnType<typeof spawn>, line: string, lines: string[]): void {
	if (!line.includes('"extension_ui_request"') || !line.includes('"confirm"')) return;
	const parsed = parseRpcLine<{ id?: string }>(line);
	if (!parsed?.id) return;
	// Verbatim in the log: this is the record of what she asked for and what the drill answered.
	lines.push(`[confirm request] ${line}`);
	lines.push(`[confirm answer] confirmed=${autoConfirm} (HER_HANDS_DRILL_CONFIRM=${process.env.HER_HANDS_DRILL_CONFIRM ?? ""})`);
	child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: parsed.id, confirmed: autoConfirm })}\n`);
}

// The rpc stream is one JSON object per line, but stderr noise and banners share the pipe;
// a line we cannot parse is not an error, it is just not an event.
function parseRpcLine<T>(line: string): T | undefined {
	try {
		return JSON.parse(line) as T;
	} catch {
		return undefined;
	}
}

// Her closing words come from the documented rpc command, not from guessing at stream event shapes.
function extractAssistantText(line: string): string | undefined {
	const parsed = parseRpcLine<{ type?: string; id?: string; data?: { text?: string | null } }>(line);
	if (parsed?.type !== "response" || parsed.id !== finalTextRequestId) return undefined;
	return parsed.data?.text ?? "";
}

async function findNotepadWindow(driver: CuaCliDriver): Promise<DriverWindow | undefined> {
	const result = await driver.run(["call", "list_windows", "{}"]);
	const windows = (JSON.parse(result.stdout || "{}").windows ?? []) as DriverWindow[];
	report("windows", windows.map((item) => ({ app: item.app_name, title: item.title })));
	return windows.find((item) => /notepad/i.test(item.app_name ?? "") || /notepad|记事本/i.test(item.title ?? ""));
}

async function readWindowText(driver: CuaCliDriver, window: DriverWindow): Promise<string> {
	const payload = JSON.stringify({
		pid: window.pid,
		window_id: window.window_id,
		include_screenshot: false,
		max_elements: 80,
	});
	const result = await driver.run(["call", "get_window_state", payload]);
	return result.stdout;
}

async function newestTrailCard(): Promise<{ file: string; body: string } | undefined> {
	const rawDir = join(memoryDir, "episodic", "raw");
	const files = (await readdir(rawDir)).sort();
	for (const file of files.reverse()) {
		const body = await readFile(join(rawDir, file), "utf8");
		if (body.includes("hands_trail")) return { file, body };
	}
	return undefined;
}

async function writeLog(path: string, lines: string[]): Promise<void> {
	await writeFile(path, lines.join("\n"), "utf8");
}

function report(label: string, payload: unknown): void {
	console.log(`--- ${label} ---`);
	console.log(JSON.stringify(payload, null, 2));
}

function delay(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
