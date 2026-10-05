import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { browserSchemas } from "./browser-schemas.ts";
import { nativeSchemas } from "./native-schemas.ts";
import { HARD_DENIED_PROCESSES, type HandsResolvedConfig } from "./policy.ts";
import { collectRefs, cuaError, cuaResult, parseDriverResult, record } from "./result.ts";
import type { HandsToolDeps } from "./tools.ts";

const schemas = { ...nativeSchemas, ...browserSchemas };
export const CUA_TOOL_NAMES = Object.keys(schemas).map((name) => `her_cua_${name}`);
export const COMPUTER_APPROVAL_PREFIX = "Samantha requests computer control:";
interface Binding {
	pid: number;
	windowId: number;
	tabs: Set<string>;
	dialogs: Map<string, string>;
	dialogReady: Set<string>;
	snapshots: Map<string, { refs: Set<string>; body: Record<string, unknown> }>;
}
interface State {
	session: string;
	bindings: Map<string, Binding>;
	calls: number;
	windows: Map<string, Record<string, unknown>>;
}
const allowedBrowsers = new Set(["chrome.exe", "msedge.exe"]);

/** Dedicated host for CUA's stateful protocol. Generic MCP closes after each call. */
export function registerCuaTools(pi: ExtensionAPI, deps: HandsToolDeps): void {
	const states = new Map<string, State>();
	let queue = Promise.resolve();
	const key = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId() ?? "interactive";
	const stateFor = (ctx: ExtensionContext) => {
		const id = key(ctx);
		let state = states.get(id);
		if (!state) {
			state = { session: `her-cua-${randomUUID()}`, bindings: new Map(), calls: 0, windows: new Map() };
			states.set(id, state);
		}
		return state;
	};
	const invoke = async (
		name: string,
		input: Record<string, unknown>,
		state: State,
		config: HandsResolvedConfig,
		signal?: AbortSignal,
	) => {
		signal?.throwIfAborted();
		const args = ["call", name, JSON.stringify({ ...input, session: state.session })];
		if (config.driverSocket) args.push("--socket", config.driverSocket);
		const result = await deps.driver.run(args, { timeoutMs: config.desktopActionTimeoutS * 1000, signal });
		signal?.throwIfAborted();
		return parseDriverResult(result);
	};
	const approve = async (ctx: ExtensionContext, name: string, details: unknown, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (!(await ctx.ui.confirm(`${COMPUTER_APPROVAL_PREFIX} ${name}`, JSON.stringify(details, null, 2), { signal })))
			throw new Error("computer control denied by user");
		signal?.throwIfAborted();
	};
	const exactWindow = async (
		input: Record<string, unknown>,
		state: State,
		config: HandsResolvedConfig,
		signal?: AbortSignal,
	) => {
		if (!Number.isInteger(input.pid) || !Number.isInteger(input.window_id))
			throw new Error("an exact window requires pid and window_id");
		const list = await invoke("list_windows", { pid: input.pid }, state, config, signal);
		const windows = Array.isArray(list.windows) ? list.windows.map(record) : [];
		const windowKey = `${input.pid}:${input.window_id}`;
		const missingAllowed =
			Array.isArray(input.expect) && input.expect.some((p) => record(record(p).window).exists === false);
		const window =
			windows.find((w) => w.pid === input.pid && w.window_id === input.window_id) ??
			(missingAllowed ? state.windows.get(windowKey) : undefined);
		if (!window) throw new Error("exact window not found; rediscover windows");
		if (!windowAllowed(window, config)) throw new Error("window app denied by Her policy");
		state.windows.set(windowKey, window);
		return window;
	};
	const observe = async (
		input: Record<string, unknown>,
		binding: Binding,
		state: State,
		config: HandsResolvedConfig,
		signal?: AbortSignal,
	) => {
		const tab = String(input.tab_id);
		const prior = input.continuation ? binding.snapshots.get(tab) : undefined;
		binding.snapshots.delete(tab);
		const body = await invoke(
			"get_browser_state",
			{ ...input, snapshot_format: "semantic_v2" },
			state,
			config,
			signal,
		);
		if (body.status !== "ok" || body.target_id !== input.target_id || body.tab_id !== input.tab_id)
			throw new Error("browser snapshot identity mismatch");
		const refs = collectRefs(body.refs);
		if (prior && record(prior.body.snapshot).id === record(body.snapshot).id)
			for (const ref of prior.refs) refs.add(ref);
		binding.snapshots.set(tab, { refs, body });
		return body;
	};
	for (const [name, descriptor] of Object.entries(schemas)) {
		const parameters = Type.Unsafe<Record<string, unknown>>(descriptor.schema);
		pi.registerTool({
			name: `her_cua_${name}`,
			label: `Her CUA ${name}`,
			description: `${descriptor.description}\nHer: live UI only; exact approved targets. Session is host-owned. Actions return fresh state; delivery alone is not goal verification.`,
			parameters,
			async execute(_id, input, signal, _onUpdate, ctx) {
				const execute = async () => {
					let state: State | undefined;
					try {
						if (!ctx?.hasUI) throw new Error("CUA requires a live UI session");
						signal?.throwIfAborted();
						if (Object.hasOwn(input, "session")) throw new Error("session is host-owned");
						if (!Check(parameters, input))
							throw new Error(`invalid ${name} arguments; follow the pinned tool schema`);
						const config = deps.loadHandsConfig();
						if (!config.enabled || !config.desktopEnabled) throw new Error("hands disabled by config");
						if (Object.hasOwn(browserSchemas, name) && !config.browserEnabled)
							throw new Error("CUA browser disabled by config");
						state = stateFor(ctx);
						let body: Record<string, unknown>;
						let goalVerified = false;
						if (name === "list_windows") {
							body = await invoke(name, input, state, config, signal);
							body = {
								windows: (Array.isArray(body.windows) ? body.windows : [])
									.map(record)
									.filter((w) => windowAllowed(w, config)),
								current_space_id: body.current_space_id,
							};
						} else if (name === "verify_state" || name === "get_window_state") {
							await exactWindow(input, state, config, signal);
							body = await invoke(name, input, state, config, signal);
							goalVerified = name === "verify_state" && body.status === "satisfied" && body.stable === true;
						} else if (name === "browser_prepare") {
							if (config.desktopTier < 2) throw new Error("browser setup requires tier 2");
							if (++state.calls > config.desktopMaxActionsPerTask)
								throw new Error("desktopMaxActionsPerTask exceeded for this turn");
							if (input.pid !== undefined) await exactWindow(input, state, config, signal);
							else if (
								input.allow_launch !== true ||
								!["isolated_new", "isolated_named"].includes(String(record(input.profile).mode))
							)
								throw new Error("browser launch requires an explicit isolated profile");
							await approve(ctx, name, input, signal);
							state.bindings.clear();
							body = await invoke(name, input, state, config, signal);
						} else if (name === "get_browser_state" && input.target_id === undefined) {
							const window = await exactWindow(input, state, config, signal);
							if (!allowedBrowsers.has(String(window.app_name).toLowerCase()))
								throw new Error("only Chrome/Edge page bindings are accepted");
							await approve(ctx, "browser binding", window, signal);
							body = await invoke(name, input, state, config, signal);
							if (
								body.status !== "ok" ||
								body.binding_quality !== "exact" ||
								body.mutation_allowed !== true ||
								typeof body.target_id !== "string" ||
								!Array.isArray(body.tabs)
							)
								throw new Error("browser bind did not prove exact mutation authority");
							// A new native binding supersedes previous target ids for that window.
							for (const [target, old] of state.bindings)
								if (old.pid === window.pid && old.windowId === window.window_id) state.bindings.delete(target);
							state.bindings.set(body.target_id, {
								pid: Number(window.pid),
								windowId: Number(window.window_id),
								tabs: new Set(body.tabs.map(record).map((t) => String(t.tab_id))),
								snapshots: new Map(),
								dialogs: new Map(),
								dialogReady: new Set(),
							});
						} else {
							const target = String(input.target_id);
							const tab = String(input.tab_id);
							const binding = state.bindings.get(target);
							if (!binding || !binding.tabs.has(tab))
								throw new Error("target/tab not bound in this chat; bind the exact window first");
							if (name === "get_browser_state") body = await observe(input, binding, state, config, signal);
							else {
								const inspection = name === "browser_dialog" && input.action === "inspect";
								if (!inspection) {
									if (config.desktopTier < 2) throw new Error("browser actions require tier 2");
									if (++state.calls > config.desktopMaxActionsPerTask)
										throw new Error("desktopMaxActionsPerTask exceeded for this turn");
									const snapshot = binding.snapshots.get(tab);
									if (name !== "browser_navigate" && name !== "browser_dialog" && !snapshot)
										throw new Error("fresh browser snapshot required");
									for (const field of ["ref", "destination_ref"])
										if (typeof input[field] === "string" && !snapshot?.refs.has(input[field]))
											throw new Error(`${field} absent from latest browser snapshot`);
									if (input.x !== undefined || input.y !== undefined) {
										if (!snapshot?.body.screenshot_png_b64)
											throw new Error(
												"coordinate action requires a fresh screenshot; use viewport CSS coordinates",
											);
										if (!Number.isFinite(input.x) || !Number.isFinite(input.y))
											throw new Error("both x and y are required");
									}
									if (
										name === "browser_dialog" &&
										(typeof input.dialog_id !== "string" || binding.dialogs.get(tab) !== input.dialog_id)
									)
										throw new Error("inspect the current dialog before resolving its exact dialog_id");
									if (name === "browser_set_input_files") await validateFiles(input.files);
									if (name === "browser_download") await validateDirectory(input.destination_root);
									await approve(
										ctx,
										name,
										{ pid: binding.pid, window_id: binding.windowId, ...input },
										signal,
									);
									binding.snapshots.delete(tab);
								}
								// Arm the event stream before input can open a blocking JavaScript modal.
								if (name !== "browser_dialog" && !binding.dialogReady.has(tab)) {
									await invoke(
										"browser_dialog",
										{ target_id: target, tab_id: tab, action: "inspect" },
										state,
										config,
										signal,
									);
									binding.dialogReady.add(tab);
								}
								const action = await invoke(name, input, state, config, signal);
								if (inspection) {
									binding.dialogReady.add(tab);
									const dialogId = record(action.dialog).dialog_id ?? action.dialog_id;
									binding.dialogs.delete(tab);
									if (typeof dialogId === "string") binding.dialogs.set(tab, dialogId);
									body = action;
								} else {
									binding.dialogs.delete(tab);
									let after: Record<string, unknown> | undefined;
									let observationError: string | undefined;
									try {
										after = await observe(
											{ target_id: target, tab_id: tab, include_screenshot: true },
											binding,
											state,
											config,
											signal,
										);
									} catch (error) {
										observationError = error instanceof Error ? error.message : String(error);
									}
									body = {
										action,
										after,
										observationError,
										verification:
											"Inspect the fresh state or call her_cua_verify_state with explicit predicates. Dispatch is not goal verification.",
									};
								}
							}
						}
						await deps.mem.capture(
							`CUA ${name}: ${goalVerified ? "verified" : "observed/delivered; goal not verified"}`,
							{ privacy: "private", provenance: "her-acted", project: "hands-desktop", type: "hands_trail" },
						);
						return cuaResult(body, {
							outcome: body.observationError ? "unverified" : "ok",
							goalVerified,
							driverSession: state.session,
						});
					} catch (error) {
						if (state)
							for (const binding of state.bindings.values()) {
								binding.snapshots.clear();
								binding.dialogs.clear();
							}
						if (state && /session.*ended|session.*expired|transport closed/i.test(String(error))) {
							state.bindings.clear();
							state.session = `her-cua-${randomUUID()}`;
						}
						return cuaError(error);
					}
				};
				const pending = queue.then(execute, execute);
				queue = pending.then(
					() => undefined,
					() => undefined,
				);
				return pending;
			},
		});
	}
	const end = async (_event: unknown, ctx: ExtensionContext) => {
		const state = states.get(key(ctx));
		if (!state) return;
		states.delete(key(ctx));
		state.bindings.clear();
		await queue;
		try {
			await invoke("end_session", {}, state, deps.loadHandsConfig());
		} catch (error) {
			console.warn("[her-cua] session cleanup failed:", error instanceof Error ? error.message : String(error));
		}
	};
	pi.on("agent_end", end);
	pi.on("session_shutdown", end);
}
function windowAllowed(window: Record<string, unknown>, config: HandsResolvedConfig): boolean {
	const app = String(window.app_name ?? "")
		.trim()
		.toLowerCase();
	if (config.desktopDeniedApps.includes(app)) return false;
	if (allowedBrowsers.has(app)) return config.browserEnabled && config.browserAllowedApps.includes(app);
	return config.desktopAllowedApps.includes(app) && !HARD_DENIED_PROCESSES.includes(app);
}
async function validateFiles(input: unknown) {
	if (!Array.isArray(input) || input.length < 1 || input.length > 32)
		throw new Error("files must contain 1-32 explicit absolute files");
	for (const file of input) {
		if (typeof file !== "string" || !isAbsolute(file) || !(await stat(await realpath(file))).isFile())
			throw new Error("file upload requires absolute regular files");
	}
}
async function validateDirectory(input: unknown) {
	if (typeof input !== "string" || !isAbsolute(input) || !(await stat(await realpath(input))).isDirectory())
		throw new Error("download requires an existing absolute destination directory");
}
