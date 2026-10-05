import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Memory } from "../her-core/memory.ts";
import { registerCuaTools } from "./cua-tools.ts";
import { CUA_DRIVER, type HandsDriver } from "./driver.ts";
import { evaluateHandsPolicy, type HandsActionKind, type HandsResolvedConfig, WRITE_ACTIONS } from "./policy.ts";
import { cuaResult, parseDriverResult } from "./result.ts";
import { registerCuaManagement } from "./runtime-management.ts";
import { type HandsTrailEntry, recordTrail } from "./trail.ts";

const actionKinds = [
	"click",
	"double_click",
	"right_click",
	"scroll",
	"type_text",
	"press_key",
	"hotkey",
	"drag",
] as const;
const deliveryModes = ["background", "foreground"] as const;

export interface HandsToolDeps {
	mem: Memory;
	loadHandsConfig: () => HandsResolvedConfig;
	driver: HandsDriver;
}

interface WindowRef {
	pid: number;
	window_id: number;
	app_name?: string;
	title?: string;
}
interface CachedSnapshot {
	snapshot_id: string;
	elements: Array<{ element_index: number; element_token?: string }>;
	capture_id?: string;
}
interface ActionInput {
	action: (typeof actionKinds)[number];
	elementIndex?: number;
	x?: number;
	y?: number;
	fromX?: number;
	fromY?: number;
	toX?: number;
	toY?: number;
	text?: string;
	key?: string;
	direction?: "up" | "down" | "left" | "right";
	deliveryMode?: "background" | "foreground";
}

export function registerHandsTools(pi: ExtensionAPI, deps: HandsToolDeps): void {
	registerCuaTools(pi, deps);
	registerCuaManagement(pi, deps.driver);
	const states = new Map<
		string,
		{ driverSession: string; taskCounts: Map<string, number>; snapshots: Map<string, CachedSnapshot> }
	>();
	const stateFor = (ctx: ExtensionContext) => {
		const id = ctx.sessionManager?.getSessionId() ?? "interactive";
		let state = states.get(id);
		if (!state) {
			state = { driverSession: `her-hands-${randomUUID()}`, taskCounts: new Map(), snapshots: new Map() };
			states.set(id, state);
		}
		return state;
	};
	const end = async (_event: unknown, ctx: ExtensionContext) => {
		const id = ctx.sessionManager?.getSessionId() ?? "interactive";
		const state = states.get(id);
		if (!state) return;
		states.delete(id);
		state.snapshots.clear();
		try {
			parseDriverResult(
				await callDriver(deps.driver, "end_session", { session: state.driverSession }, deps.loadHandsConfig()),
			);
		} catch (error) {
			console.warn("[her-hands] session cleanup failed:", errorMessage(error));
		}
	};
	pi.on("agent_end", end);
	pi.on("session_shutdown", end);
	pi.registerTool({
		name: "her_hands_snapshot",
		label: "Her Hands Snapshot",
		description: "Read a whitelisted desktop app UIA tree through cua-driver.",
		parameters: Type.Object({
			process: Type.String(),
			windowTitleHint: Type.Optional(Type.String()),
			pid: Type.Optional(Type.Integer()),
			windowId: Type.Optional(Type.Integer()),
			includeScreenshot: Type.Optional(Type.Boolean()),
			query: Type.Optional(Type.String()),
			maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!hasLiveUi(ctx)) return await denyNoUi(deps, "snapshot", params.process);
			const config = deps.loadHandsConfig();
			const { driverSession, snapshots } = stateFor(ctx);
			const policy = evaluateHandsPolicy({
				surface: "desktop",
				action: "snapshot",
				targetProcess: params.process,
				config,
			});
			if (!policy.allow) return await denyPolicy(deps, "snapshot", params.process, policy.reason);
			try {
				const windowRef = await findWindow(
					deps.driver,
					params.process,
					params.windowTitleHint,
					config,
					params.pid,
					params.windowId,
					signal,
				);
				snapshots.delete(windowKey(windowRef));
				const result = await callDriver(
					deps.driver,
					CUA_DRIVER.snapshotTool,
					{
						pid: windowRef.pid,
						window_id: windowRef.window_id,
						include_screenshot: params.includeScreenshot ?? true,
						query: params.query,
						max_elements: params.maxElements,
						session: driverSession,
					},
					config,
					signal,
				);
				const outcome = result.ok ? "ok" : "error";
				if (result.ok) cacheSnapshot(snapshots, windowRef, result.stdout);
				await recordTrail(deps.mem, `snapshot ${params.process}`, [
					entry("snapshot", params.process, "background", outcome, detail(result)),
				]);
				return cuaResult(parseDriverResult(result), {
					outcome,
					window: windowRef,
				});
			} catch (error) {
				snapshots.clear();
				const message = errorMessage(error);
				await recordTrail(deps.mem, `snapshot ${params.process}`, [
					entry("snapshot", params.process, "background", "error", message),
				]);
				return textResult(`hands snapshot error: ${message}`, { outcome: "error" });
			}
		},
	});

	pi.registerTool({
		name: "her_hands_act",
		label: "Her Hands Act",
		description: "Execute a batch of whitelisted desktop actions through cua-driver.",
		parameters: Type.Object({
			process: Type.String(),
			pid: Type.Optional(Type.Integer()),
			windowId: Type.Optional(Type.Integer()),
			windowTitleHint: Type.Optional(Type.String()),
			taskLabel: Type.String(),
			actions: Type.Array(
				Type.Object({
					action: StringEnum(actionKinds),
					elementIndex: Type.Optional(Type.Integer({ minimum: 0 })),
					x: Type.Optional(Type.Number()),
					y: Type.Optional(Type.Number()),
					fromX: Type.Optional(Type.Number()),
					fromY: Type.Optional(Type.Number()),
					toX: Type.Optional(Type.Number()),
					toY: Type.Optional(Type.Number()),
					text: Type.Optional(Type.String()),
					key: Type.Optional(Type.String()),
					direction: Type.Optional(StringEnum(["up", "down", "left", "right"] as const)),
					deliveryMode: Type.Optional(StringEnum(deliveryModes)),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!hasLiveUi(ctx)) return await denyNoUi(deps, "click", params.process);
			const config = deps.loadHandsConfig();
			const { driverSession, snapshots, taskCounts } = stateFor(ctx);
			signal?.throwIfAborted();
			const actions = params.actions as ActionInput[];
			const limit = enforceTaskLimit(taskCounts, params.taskLabel, actions.length, config);
			if (limit) return await denyBatch(deps, params.taskLabel, params.process, limit);
			const policyStop = firstPolicyStop(params.process, actions, config);
			const executable = policyStop ? actions.slice(0, policyStop.index) : actions;
			const trail: HandsTrailEntry[] = [];
			let after: Record<string, unknown> | undefined;
			let observationError: string | undefined;
			try {
				if (executable.length > 0) {
					// Resolved before the confirm on purpose (2026-08-03): a name match once landed on a
					// pre-existing Notepad holding Fei's real file, so the dialog must name the exact
					// window the actions would land in. Costs one read-only list_windows before the ask.
					const windowRef = await findWindow(
						deps.driver,
						params.process,
						params.windowTitleHint,
						config,
						params.pid,
						params.windowId,
						signal,
					);
					if (executable.some((item) => WRITE_ACTIONS.includes(item.action))) {
						const confirmed = await ctx.ui.confirm(
							`Samantha requests desktop control: ${params.process}`,
							`${describeTargetWindow(windowRef)}\n${summarizeActions(executable)}`,
							{ signal },
						);
						if (!confirmed)
							return await denyBatch(
								deps,
								params.taskLabel,
								params.process,
								"confirm denied",
								executable[0]?.action,
							);
					}
					const cachedSnapshot = snapshots.get(windowKey(windowRef));
					if (!cachedSnapshot) throw new Error("snapshot required: call her_hands_snapshot for this window first");
					for (const item of executable) {
						const result = await callDriver(
							deps.driver,
							item.action,
							actionPayload(item, windowRef, cachedSnapshot, driverSession),
							config,
							signal,
						);
						const outcome = actionOutcome(result);
						trail.push(
							entry(item.action, params.process, item.deliveryMode ?? "background", outcome, detail(result)),
						);
						if (outcome !== "ok") {
							snapshots.delete(windowKey(windowRef));
							break;
						}
					}
					// Every dispatched batch is followed by a new observation; old handles never survive it.
					snapshots.delete(windowKey(windowRef));
					try {
						const observed = await callDriver(
							deps.driver,
							CUA_DRIVER.snapshotTool,
							{
								pid: windowRef.pid,
								window_id: windowRef.window_id,
								include_screenshot: true,
								session: driverSession,
							},
							config,
							signal,
						);
						after = parseDriverResult(observed);
						cacheSnapshot(snapshots, windowRef, observed.stdout);
					} catch (error) {
						observationError = errorMessage(error);
					}
				}
				if (trail.every((item) => item.outcome === "ok") && policyStop) {
					trail.push(
						entry(
							policyStop.action,
							params.process,
							policyStop.deliveryMode,
							"denied",
							`${policyStop.reason}; ${actions.length - policyStop.index - 1} skipped`,
						),
					);
				}
				await recordTrail(deps.mem, params.taskLabel, trail);
				return cuaResult(
					{
						summary: renderActSummary(trail),
						after,
						observationError,
						verification:
							"Delivery is not goal verification. Inspect the fresh state or call her_cua_verify_state with explicit predicates.",
					},
					{ trail, goalVerified: false, observationAvailable: !!after },
				);
			} catch (error) {
				snapshots.clear();
				const message = errorMessage(error);
				trail.push(entry(actions[trail.length]?.action ?? "click", params.process, "background", "error", message));
				await recordTrail(deps.mem, params.taskLabel, trail);
				return textResult(`hands act error: ${message}`, { trail });
			}
		},
	});
}

function hasLiveUi(ctx: ExtensionContext | undefined): ctx is ExtensionContext {
	return ctx?.hasUI === true;
}

async function denyNoUi(deps: HandsToolDeps, action: HandsActionKind, process: string) {
	const reason = "hands require a live UI session (no autonomous/heartbeat use)";
	await recordTrail(deps.mem, `denied ${process}`, [entry(action, process, "background", "denied", reason)]);
	return textResult(reason, { outcome: "denied", reason });
}

async function denyPolicy(deps: HandsToolDeps, action: HandsActionKind, process: string, reason: string) {
	const text = reason === "hands disabled" ? "hands disabled by config (hands.enabled=false)" : reason;
	await recordTrail(deps.mem, `denied ${process}`, [entry(action, process, "background", "denied", text)]);
	return textResult(text, { outcome: "denied", reason: text });
}

async function denyBatch(
	deps: HandsToolDeps,
	taskLabel: string,
	process: string,
	reason: string,
	action: HandsActionKind = "click",
) {
	const trail = [entry(action, process, "background", "denied", reason)];
	await recordTrail(deps.mem, taskLabel, trail);
	return textResult(reason, { outcome: "denied", trail });
}

function firstPolicyStop(
	process: string,
	actions: ActionInput[],
	config: HandsResolvedConfig,
): { index: number; action: HandsActionKind; deliveryMode: "background" | "foreground"; reason: string } | undefined {
	for (const [index, item] of actions.entries()) {
		const decision = evaluateHandsPolicy({ surface: "desktop", action: item.action, targetProcess: process, config });
		if (!decision.allow)
			return {
				index,
				action: item.action,
				deliveryMode: item.deliveryMode ?? "background",
				reason: decision.reason,
			};
	}
	return undefined;
}

function enforceTaskLimit(
	counts: Map<string, number>,
	taskLabel: string,
	next: number,
	config: HandsResolvedConfig,
): string | undefined {
	const used = counts.get(taskLabel) ?? 0;
	if (used + next > config.desktopMaxActionsPerTask)
		return `desktopMaxActionsPerTask exceeded: ${used + next}/${config.desktopMaxActionsPerTask}`;
	counts.set(taskLabel, used + next);
	return undefined;
}

async function findWindow(
	driver: HandsDriver,
	process: string,
	titleHint: string | undefined,
	config: HandsResolvedConfig,
	pid?: number,
	windowId?: number,
	signal?: AbortSignal,
): Promise<WindowRef> {
	const result = await callDriver(driver, "list_windows", {}, config, signal);
	if (!result.ok) throw new Error(detail(result));
	const body = JSON.parse(result.stdout) as { windows?: Array<WindowRef & { app_name?: string; title?: string }> };
	const target = process.trim().toLowerCase();
	const windows = body.windows ?? [];
	const titleMatches = (item: { title?: string }) =>
		!titleHint || (item.title ?? "").toLowerCase().includes(titleHint.toLowerCase());
	const candidates = windows.filter(
		(item) =>
			(item.app_name ?? "").trim().toLowerCase() === target &&
			titleMatches(item) &&
			(pid === undefined || item.pid === pid) &&
			(windowId === undefined || item.window_id === windowId),
	);
	if (candidates.length > 1)
		throw new Error("ambiguous window: choose exact pid and windowId from her_cua_list_windows");
	const window = candidates[0];
	if (!window) throw new Error(`no window found for ${process}${titleHint ? ` (${titleHint})` : ""}`);
	return { pid: window.pid, window_id: window.window_id, app_name: window.app_name, title: window.title };
}

async function callDriver(
	driver: HandsDriver,
	tool: string,
	payload: Record<string, unknown>,
	config: HandsResolvedConfig,
	signal?: AbortSignal,
) {
	const args = ["call", tool, JSON.stringify(payload)];
	if (config.driverSocket) args.push("--socket", config.driverSocket);
	signal?.throwIfAborted();
	const result = await driver.run(args, { timeoutMs: config.desktopActionTimeoutS * 1000, signal });
	signal?.throwIfAborted();
	return result;
}

function actionPayload(
	action: ActionInput,
	window: WindowRef,
	snapshot: CachedSnapshot | undefined,
	driverSession: string,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		pid: window.pid,
		window_id: window.window_id,
		delivery_mode: action.deliveryMode ?? "background",
		session: driverSession,
	};
	const hasCoordinates = action.x !== undefined || action.y !== undefined;
	if (hasCoordinates && action.elementIndex !== undefined) throw new Error("use elementIndex or x/y, not both");
	if ((action.x === undefined) !== (action.y === undefined)) throw new Error("x and y must be provided together");
	if (action.elementIndex !== undefined) {
		if (!snapshot) throw new Error("snapshot required for elementIndex");
		const element = snapshot.elements.find((item) => item.element_index === action.elementIndex);
		if (!element) throw new Error("elementIndex is absent from the latest snapshot");
		if (!element.element_token) throw new Error("CUA 0.33.3 requires an opaque element_token; take a fresh snapshot");
		payload.element_token = element.element_token;
	}
	if (hasCoordinates) {
		if (!snapshot?.capture_id) throw new Error("coordinate action requires a fresh screenshot capture_id");
		payload.capture_id = snapshot.capture_id;
	}
	if (action.x !== undefined) payload.x = action.x;
	if (action.y !== undefined) payload.y = action.y;
	if (action.action === "drag") {
		if (!snapshot?.capture_id) throw new Error("drag requires a fresh screenshot");
		const points = [action.fromX, action.fromY, action.toX, action.toY];
		if (
			!points.every((value) => typeof value === "number" && Number.isFinite(value)) ||
			hasCoordinates ||
			action.elementIndex !== undefined
		) {
			throw new Error("drag requires fromX/fromY/toX/toY and no elementIndex or x/y");
		}
		payload.from_x = action.fromX;
		payload.from_y = action.fromY;
		payload.to_x = action.toX;
		payload.to_y = action.toY;
	}
	if (action.text !== undefined) payload.text = action.text;
	if (action.key !== undefined)
		payload[action.action === "hotkey" ? "keys" : "key"] =
			action.action === "hotkey" ? action.key.split("+") : action.key;
	if (action.direction !== undefined) payload.direction = action.direction;
	return payload;
}

function cacheSnapshot(snapshots: Map<string, CachedSnapshot>, window: WindowRef, stdout: string): void {
	const body = JSON.parse(stdout) as CachedSnapshot;
	if (
		typeof body?.snapshot_id !== "string" ||
		!/^s[0-9a-f]{8}$/.test(body.snapshot_id) ||
		!Array.isArray(body.elements) ||
		body.elements.some(
			(item) =>
				!item ||
				!Number.isInteger(item.element_index) ||
				(item.element_token !== undefined && typeof item.element_token !== "string"),
		)
	) {
		throw new Error("invalid CUA snapshot: expected snapshot_id and structured elements");
	}
	snapshots.set(windowKey(window), body);
}

function actionOutcome(result: { ok: boolean; stdout: string }): HandsTrailEntry["outcome"] {
	if (!result.ok) return "error";
	try {
		const body = JSON.parse(result.stdout) as { effect?: string; isError?: boolean };
		if (body?.isError || body?.effect === "refused") return "error";
		return body?.effect === "confirmed" ? "ok" : "unverified";
	} catch {
		return "unverified";
	}
}
function windowKey(window: WindowRef): string {
	return `${window.pid}:${window.window_id}`;
}
function entry(
	action: HandsActionKind,
	targetProcess: string,
	deliveryMode: "background" | "foreground",
	outcome: HandsTrailEntry["outcome"],
	detailText: string,
): HandsTrailEntry {
	return { ts: new Date().toISOString(), action, targetProcess, deliveryMode, outcome, detail: detailText };
}

function detail(result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): string {
	return [
		result.stdout.trim().replace(/("screenshot_png_b64"\s*:\s*")[^"]*/g, "$1[image omitted]"),
		result.stderr.trim(),
		result.timedOut ? "timed out" : "",
		result.exitCode === 0 ? "" : `exit ${result.exitCode}`,
	]
		.filter(Boolean)
		.join("\n");
}

function renderActSummary(trail: HandsTrailEntry[]): string {
	const error = trail.find((item) => item.outcome === "error");
	if (error) return `hands act error:\n${error.detail}`;
	const unverified = trail.find((item) => item.outcome === "unverified");
	if (unverified) return `hands act unverified (stopped; inspect the target before continuing):\n${unverified.detail}`;
	const denied = trail.find((item) => item.outcome === "denied");
	if (denied) return `hands act denied:\n${denied.detail}`;
	return "hands act delivered; goal unverified";
}

function summarizeActions(actions: ActionInput[]): string {
	return actions.map((item, index) => `${index + 1}. ${item.action}${describePayload(item)}`).join("\n");
}

// A tier-2 approval is only worth asking for if it shows what is about to be typed or pressed.
function describePayload(action: ActionInput): string {
	if (action.action === "drag") return `: (${action.fromX}, ${action.fromY}) -> (${action.toX}, ${action.toY})`;
	if (action.text !== undefined) return `: ${oneLine(action.text)}`;
	if (action.key !== undefined) return `: ${oneLine(action.key)}`;
	if (action.direction !== undefined) return `: ${action.direction}`;
	return "";
}

// Fei must see which window the keys would land in before nodding (2026-08-03 lesson).
function describeTargetWindow(window: WindowRef): string {
	return `target window: ${oneLine(`${window.app_name ?? "?"} — ${window.title ?? ""}`, 80)}`;
}

function oneLine(value: string, max = 120): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
