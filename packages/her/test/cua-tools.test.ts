import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerCuaTools } from "../src/hands/cua-tools.ts";
import { type DriverResult, FakeDriver } from "../src/hands/driver.ts";
import { resolveHandsConfig } from "../src/hands/policy.ts";
import { DEFAULT_CONFIG } from "../src/her-core/config.ts";
import type { Memory } from "../src/her-core/memory.ts";

const window = { pid: 10, window_id: 20, app_name: "chrome.exe", title: "Owned browser" };
const binding = {
	status: "ok",
	binding_quality: "exact",
	mutation_allowed: true,
	target_id: "bt-one",
	tabs: [{ tab_id: "tab-one", url: "https://example.com", active: true }],
};
const page = {
	status: "ok",
	mode: "snapshot",
	target_id: "bt-one",
	tab_id: "tab-one",
	snapshot: { id: "p1" },
	page: { url: "https://example.com", title: "Fixture" },
	refs: [{ ref: "p1:0", role: "textbox" }],
	outline: "Fixture",
};
function result(tool: string, body: object) {
	return {
		match: new RegExp(`^call ${tool} `),
		result: {
			ok: true,
			exitCode: 0,
			stdout: JSON.stringify(body),
			stderr: "",
			timedOut: false,
		} satisfies DriverResult,
	};
}
function context(id = "chat-one", allow = true, hasUI = true) {
	const confirmations: string[] = [];
	return {
		confirmations,
		ctx: {
			hasUI,
			sessionManager: { getSessionId: () => id },
			ui: {
				confirm: async (title: string, message: string) => {
					confirmations.push(`${title}\n${message}`);
					return allow;
				},
			},
		} as unknown as ExtensionContext,
	};
}
function harness(cases: ReturnType<typeof result>[] = [], enabled = true) {
	const tools = new Map<string, ToolDefinition>();
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const driver = new FakeDriver(cases);
	const pi = {
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, fn),
	} as unknown as ExtensionAPI;
	registerCuaTools(pi, {
		driver,
		mem: { capture: async () => "test" } as unknown as Memory,
		loadHandsConfig: () =>
			resolveHandsConfig({
				...DEFAULT_CONFIG.hands,
				enabled,
				desktopEnabled: true,
				desktopAllowedApps: "notepad.exe",
				browserEnabled: true,
				browserAllowedApps: "chrome.exe,msedge.exe",
				desktopTier: 2,
			}),
	});
	const call = async (name: string, args: Record<string, unknown>, ctx = context().ctx, signal?: AbortSignal) => {
		const tool = tools.get(`her_cua_${name}`);
		assert.ok(tool, name);
		return tool.execute("call-1", args, signal, undefined, ctx);
	};
	return { tools, events, driver, call };
}
const bindCases = () => [result("list_windows", { windows: [window] }), result("get_browser_state", binding)];
async function bind(h: ReturnType<typeof harness>, ctx = context().ctx) {
	return h.call("get_browser_state", { pid: 10, window_id: 20 }, ctx);
}
function text(r: Awaited<ReturnType<ReturnType<typeof harness>["call"]>>) {
	return r.content
		.filter((b) => b.type === "text")
		.map((b) => (b.type === "text" ? b.text : ""))
		.join("\n");
}

test("CUA browser tools expose pinned schemas without host session override", () => {
	const h = harness();
	for (const name of [
		"browser_prepare",
		"get_browser_state",
		"browser_navigate",
		"browser_click",
		"browser_type",
		"browser_pointer",
		"browser_dialog",
		"browser_set_input_files",
		"browser_download",
		"verify_state",
		"list_windows",
	]) {
		const t = h.tools.get(`her_cua_${name}`);
		assert.ok(t);
		assert.equal(
			Object.hasOwn((t.parameters as unknown as { properties: Record<string, unknown> }).properties, "session"),
			false,
		);
	}
});
test("disabled, headless, or aborted calls never reach desktop", async () => {
	const a = harness([], false);
	assert.match(text(await a.call("list_windows", {})), /disabled/);
	assert.equal(a.driver.calls.length, 0);
	const b = harness();
	assert.match(text(await b.call("list_windows", {}, context("x", true, false).ctx)), /live UI/);
	assert.equal(b.driver.calls.length, 0);
	const c = new AbortController();
	c.abort();
	assert.match(text(await b.call("list_windows", {}, context().ctx, c.signal)), /abort/i);
	assert.equal(b.driver.calls.length, 0);
});
test("windows discovery filters unrelated apps and keeps exact identifiers", async () => {
	const h = harness([
		result("list_windows", { windows: [window, { pid: 9, window_id: 9, app_name: "pwsh.exe", title: "private" }] }),
	]);
	const r = await h.call("list_windows", {});
	assert.match(text(r), /Owned browser/);
	assert.doesNotMatch(text(r), /private|pwsh/);
});
test("native binding refuses a mismatched process/window", async () => {
	const h = harness([result("list_windows", { windows: [window] })]);
	assert.match(text(await h.call("get_browser_state", { pid: 11, window_id: 20 })), /exact window|not found/i);
	assert.equal(h.driver.calls.length, 1);
});
test("browser binding authorization is real and denial makes no bind call", async () => {
	const h = harness([result("list_windows", { windows: [window] })]);
	const c = context("a", false);
	assert.match(text(await bind(h, c.ctx)), /denied/);
	assert.equal(c.confirmations.length, 1);
	assert.equal(h.driver.calls.length, 1);
});
test("heuristic binding never authorizes page mutation", async () => {
	const h = harness([
		result("list_windows", { windows: [window] }),
		result("get_browser_state", { ...binding, binding_quality: "heuristic", mutation_allowed: false }),
	]);
	await bind(h);
	assert.match(
		text(await h.call("browser_navigate", { target_id: "bt-one", tab_id: "tab-one", url: "https://example.com" })),
		/bind|target/i,
	);
	assert.equal(h.driver.calls.length, 2);
});
test("snapshot preserves screenshot as image and scoped semantic refs", async () => {
	const h = harness([
		...bindCases(),
		result("get_browser_state", { ...page, screenshot_png_b64: "aGVsbG8=", screenshot_mime_type: "image/png" }),
	]);
	await bind(h);
	const r = await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one", include_screenshot: true });
	assert.equal(r.content.find((x) => x.type === "image")?.type, "image");
	assert.doesNotMatch(text(r), /aGVsbG8=/);
	assert.match(text(r), /untrusted|SCREEN CONTENT/);
});
test("cross-chat target use cannot inherit a browser grant", async () => {
	const h = harness(bindCases());
	await bind(h);
	assert.match(
		text(
			await h.call(
				"browser_navigate",
				{ target_id: "bt-one", tab_id: "tab-one", url: "https://example.com" },
				context("other").ctx,
			),
		),
		/bind|target/i,
	);
	assert.equal(h.driver.calls.length, 2);
});
test("unknown refs are rejected before browser input", async () => {
	const h = harness([...bindCases(), result("get_browser_state", page)]);
	await bind(h);
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	assert.match(
		text(await h.call("browser_click", { target_id: "bt-one", tab_id: "tab-one", ref: "p0:999" })),
		/ref|snapshot/i,
	);
	assert.equal(h.driver.calls.length, 3);
});
test("action includes fresh observation but never equates dispatch with goal verification", async () => {
	const h = harness([
		...bindCases(),
		result("get_browser_state", page),
		result("browser_dialog", { status: "ok", present: false }),
		result("browser_type", { status: "ok" }),
		result("get_browser_state", { ...page, snapshot: { id: "p2" }, refs: [{ ref: "p2:0", value: "typed" }] }),
	]);
	await bind(h);
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	const c = context();
	const r = await h.call(
		"browser_type",
		{ target_id: "bt-one", tab_id: "tab-one", ref: "p1:0", text: "typed" },
		c.ctx,
	);
	assert.equal(c.confirmations.length, 1);
	assert.match(text(r), /p2:0/);
	assert.equal((r.details as { goalVerified: boolean }).goalVerified, false);
	const stale = await h.call("browser_type", { target_id: "bt-one", tab_id: "tab-one", ref: "p1:0", text: "again" });
	assert.match(text(stale), /ref|snapshot/i);
	assert.equal(h.driver.calls.length, 6);
});
test("failed browser observation invalidates previous refs", async () => {
	const h = harness([
		...bindCases(),
		result("get_browser_state", page),
		result("get_browser_state", { isError: true, error: "gone" }),
	]);
	await bind(h);
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	assert.match(
		text(await h.call("browser_click", { target_id: "bt-one", tab_id: "tab-one", ref: "p1:0" })),
		/snapshot|ref|bind/i,
	);
	assert.equal(h.driver.calls.length, 4);
});
test("unknown verification is never promoted to verified", async () => {
	const h = harness([
		result("list_windows", { windows: [{ ...window, app_name: "notepad.exe" }] }),
		result("verify_state", { status: "unknown", satisfied: false }),
	]);
	const r = await h.call("verify_state", { pid: 10, window_id: 20, expect: [{ window: { exists: true } }] });
	assert.equal((r.details as { goalVerified: boolean }).goalVerified, false);
});
test("extra authority fields are rejected, not forwarded to driver", async () => {
	const h = harness();
	assert.match(text(await h.call("list_windows", { session: "foreign" })), /session|host/i);
	assert.equal(h.driver.calls.length, 0);
});
test("only stable satisfied predicates count as verified", async () => {
	for (const stable of [true, false]) {
		const h = harness([
			result("list_windows", { windows: [window] }),
			result("verify_state", { status: "satisfied", stable }),
		]);
		const r = await h.call("verify_state", { pid: 10, window_id: 20, expect: [{ window: { exists: true } }] });
		assert.equal((r.details as { goalVerified: boolean }).goalVerified, stable);
	}
});
test("window observation returns images, preserves coverage, and cannot write arbitrary files", async () => {
	const h = harness([
		result("list_windows", { windows: [window] }),
		result("get_window_state", {
			snapshot_id: "s00000002",
			capture_id: "cap",
			elements: [],
			elements_complete: false,
			screenshot_png_b64: "aGVsbG8=",
		}),
	]);
	const r = await h.call("get_window_state", { pid: 10, window_id: 20, include_screenshot: true });
	assert.ok(r.content.some((c) => c.type === "image"));
	assert.match(text(r), /elements_complete/);
	assert.match(
		text(await h.call("get_window_state", { pid: 10, window_id: 20, screenshot_out_file: "C:/private.png" })),
		/invalid/,
	);
	assert.equal(h.driver.calls.length, 2);
});
test("end of turn revokes binding and creates a fresh driver session", async () => {
	const h = harness([...bindCases(), result("end_session", { status: "ok" }), ...bindCases()]);
	const c = context();
	await bind(h, c.ctx);
	const old = JSON.parse(h.driver.calls[1][2]).session;
	await h.events.get("agent_end")!({}, c.ctx);
	assert.match(
		text(
			await h.call(
				"browser_navigate",
				{ target_id: "bt-one", tab_id: "tab-one", url: "https://example.com" },
				c.ctx,
			),
		),
		/not bound/,
	);
	await bind(h, c.ctx);
	assert.notEqual(JSON.parse(h.driver.calls.at(-1)![2]).session, old);
});
test("dialog resolution requires its inspected generation", async () => {
	const h = harness([
		...bindCases(),
		result("browser_dialog", { status: "ok", dialog: { dialog_id: "d1", type: "prompt" } }),
		result("browser_dialog", { status: "ok" }),
		result("get_browser_state", page),
	]);
	await bind(h);
	await h.call("browser_dialog", { target_id: "bt-one", tab_id: "tab-one", action: "inspect" });
	const r = await h.call("browser_dialog", {
		target_id: "bt-one",
		tab_id: "tab-one",
		action: "accept",
		dialog_id: "d1",
		prompt_text: "owned",
	});
	assert.match(text(r), /after/);
	assert.equal(h.driver.calls.length, 5);
});

test("an input refusal keeps the exact binding for dialog inspection and never retries input", async () => {
	const h = harness([
		...bindCases(),
		result("get_browser_state", page),
		result("browser_dialog", { status: "ok", present: false }),
		result("browser_type", { effect: "refused", error: { code: "browser_input_trust_unavailable" } }),
		result("browser_dialog", { status: "ok", present: true, dialog_id: "d1" }),
	]);
	await bind(h);
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	assert.match(
		text(await h.call("browser_type", { target_id: "bt-one", tab_id: "tab-one", ref: "p1:0", text: "owned" })),
		/refused/,
	);
	const inspected = await h.call("browser_dialog", { target_id: "bt-one", tab_id: "tab-one", action: "inspect" });
	assert.match(text(inspected), /d1/);
	assert.equal(h.driver.calls.filter((c) => c[1] === "browser_type").length, 1);
});
test("browser actions denied by the user never arm events or send input", async () => {
	const h = harness([...bindCases(), result("get_browser_state", page)]);
	await bind(h);
	await h.call("get_browser_state", { target_id: "bt-one", tab_id: "tab-one" });
	const denied = await h.call(
		"browser_type",
		{ target_id: "bt-one", tab_id: "tab-one", ref: "p1:0", text: "owned" },
		context("chat-one", false).ctx,
	);
	assert.match(text(denied), /denied/);
	assert.equal(h.driver.calls.length, 3);
});

test("a previously observed exact window can be verified absent after closure", async () => {
	const h = harness([
		result("list_windows", { windows: [window] }),
		result("get_window_state", { snapshot_id: "s00000001", elements: [] }),
		result("list_windows", { windows: [] }),
		result("verify_state", { status: "satisfied", stable: true }),
	]);
	await h.call("get_window_state", { pid: 10, window_id: 20 });
	const closed = await h.call("verify_state", { pid: 10, window_id: 20, expect: [{ window: { exists: false } }] });
	assert.equal((closed.details as { goalVerified: boolean }).goalVerified, true);
});
