import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendAuditLog } from "../lib/audit.ts";
import { evaluate, policyEnvelope, resolveToolCallAnchor } from "../lib/cedar.ts";
import { resolveGovernedTool } from "../lib/governed-tools.ts";
import { isAnchorPath } from "../rsi/anchors.ts";

/** ADR-0005 / G-284. Types below are copied verbatim from her-rsi-contracts/selfmod.ts. */
export const AGENT_TOOL_WRAPPABLE_V1: readonly string[] = ["bash"];

export interface AgentMadeToolDecl {
	/** unique within the session; never persisted */
	name: string;
	/** which existing capability this wraps; must be in AGENT_TOOL_WRAPPABLE_V1 */
	wraps: string;
	/** why it exists, one line, for the audit row */
	purpose: string;
	/**
	 * Declared scope. Must be NARROWER THAN OR EQUAL TO the wrapped capability's current
	 * permission — a declaration wider than `wraps` is rejected at registration.
	 */
	scope: {
		/** allowed path prefixes; empty = no filesystem target */
		pathPrefixes: string[];
		/** true = the wrapper may not mutate anything */
		readOnly: boolean;
		/** allowed command shapes (exact argv heads); empty = the wrapper takes no command */
		commandHeads: string[];
	};
}

/** Registration outcome. Ephemeral only: the registry lives in memory and dies with the process. */
export type AgentToolRegistration =
	| { ok: true; tool: AgentMadeToolDecl }
	| { ok: false; reason: "wider-than-wrapped" | "not-wrappable" | "name-taken" | "malformed" };

export const AGENT_TOOL_AUDIT_ORIGIN = "agent-made" as const;

export interface AgentToolCallInput {
	command: string;
	path?: string;
}

export interface AgentToolWrappedResult {
	ok: boolean;
	output?: string;
	reason?: string;
}

export interface AgentToolCallOptions {
	cwd: string;
	memoryDir: string;
	now?: string;
	runWrapped: (wraps: string, input: AgentToolCallInput) => AgentToolWrappedResult;
}

export type AgentToolMatchedScope = { commandHead?: string; pathPrefix?: string };

export type AgentToolCallResult =
	| {
			ok: true;
			origin: typeof AGENT_TOOL_AUDIT_ORIGIN;
			matchedScope: AgentToolMatchedScope;
			wrapped: { tool: string; output?: string };
	  }
	| { ok: false; origin: typeof AGENT_TOOL_AUDIT_ORIGIN; reason: string };

export interface AgentToolAuditOpts {
	memoryDir: string;
	now?: string;
}

export interface AgentToolRegistry {
	register(decl: AgentMadeToolDecl, audit: AgentToolAuditOpts): AgentToolRegistration;
	get(name: string): AgentMadeToolDecl | undefined;
	call(name: string, input: AgentToolCallInput, opts: AgentToolCallOptions): AgentToolCallResult;
	propose(
		name: string,
		opts: { destRoot: string },
	): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
}

interface RecordedCall {
	command: string;
	ok: boolean;
}

interface Slot {
	calls: RecordedCall[];
	decl: AgentMadeToolDecl;
}

const WRITE_MARK =
	/(?:^|[\s;|&])(rm|mv|mkdir|touch|chmod|dd|tee|Set-Content|Out-File|Add-Content|Remove-Item|Move-Item|Copy-Item|New-Item)(?:[\s]|$)/i;

export function createAgentToolRegistry(): AgentToolRegistry {
	const slots = new Map<string, Slot>();

	return {
		register(decl, audit) {
			const now = audit.now ?? new Date().toISOString();
			const shape = validateShape(decl);
			if (!shape.ok) {
				writeRegisterAudit(decl, audit.memoryDir, now, "DENY", shape.reason);
				return shape;
			}
			if (!AGENT_TOOL_WRAPPABLE_V1.includes(decl.wraps)) {
				writeRegisterAudit(decl, audit.memoryDir, now, "DENY", "not-wrappable");
				return { ok: false, reason: "not-wrappable" };
			}
			if (isWiderThanWrapped(decl)) {
				writeRegisterAudit(decl, audit.memoryDir, now, "DENY", "wider-than-wrapped");
				return { ok: false, reason: "wider-than-wrapped" };
			}
			if (slots.has(decl.name)) {
				writeRegisterAudit(decl, audit.memoryDir, now, "DENY", "name-taken");
				return { ok: false, reason: "name-taken" };
			}
			const tool = cloneDecl(decl);
			slots.set(tool.name, { decl: tool, calls: [] });
			writeRegisterAudit(tool, audit.memoryDir, now, "ALLOW", "agent-tool-register");
			return { ok: true, tool };
		},

		get(name) {
			return slots.get(name)?.decl;
		},

		call(name, input, opts) {
			const now = opts.now ?? new Date().toISOString();
			const slot = slots.get(name);
			if (!slot) {
				writeCallAudit(name, undefined, input, opts.memoryDir, now, "DENY", "not-registered", undefined);
				return { ok: false, origin: AGENT_TOOL_AUDIT_ORIGIN, reason: "not-registered" };
			}
			const decl = slot.decl;
			const target = resolveToolCallAnchor({
				cwd: opts.cwd,
				memoryDir: opts.memoryDir,
				input: { command: input.command, path: input.path },
			});
			if (target?.anchorPath) {
				writeCallAudit(name, decl, input, opts.memoryDir, now, "DENY", "forbid_anchor_write", undefined);
				return { ok: false, origin: AGENT_TOOL_AUDIT_ORIGIN, reason: "forbid_anchor_write" };
			}

			const scoped = matchScope(decl, input, target?.targetPath);
			if (!scoped.ok) {
				writeCallAudit(name, decl, input, opts.memoryDir, now, "DENY", "scope", undefined);
				return { ok: false, origin: AGENT_TOOL_AUDIT_ORIGIN, reason: "scope" };
			}

			const wrappedVerdict = evaluateWrapped(decl.wraps, target?.anchorPath);
			if (wrappedVerdict.decision === "deny") {
				const reason = wrappedVerdict.matched[0] ?? "wrapped-deny";
				writeCallAudit(name, decl, input, opts.memoryDir, now, "DENY", reason, scoped.matched);
				return { ok: false, origin: AGENT_TOOL_AUDIT_ORIGIN, reason };
			}

			const wrapped = opts.runWrapped(decl.wraps, input);
			if (!wrapped.ok) {
				const reason = wrapped.reason ?? "wraps-channel-deny";
				slot.calls.push({ command: summarize(input.command), ok: false });
				writeCallAudit(name, decl, input, opts.memoryDir, now, "DENY", reason, scoped.matched);
				return { ok: false, origin: AGENT_TOOL_AUDIT_ORIGIN, reason };
			}
			slot.calls.push({ command: summarize(input.command), ok: true });
			writeCallAudit(name, decl, input, opts.memoryDir, now, "ALLOW", null, scoped.matched);
			return {
				ok: true,
				origin: AGENT_TOOL_AUDIT_ORIGIN,
				matchedScope: scoped.matched,
				wrapped: { tool: decl.wraps, output: wrapped.output },
			};
		},

		async propose(name, opts) {
			const slot = slots.get(name);
			if (!slot) return { ok: false, reason: "not-registered" };
			const dir = join(opts.destRoot, "proposals", "tools");
			await mkdir(dir, { recursive: true });
			const path = join(dir, `${slot.decl.name}.md`);
			await writeFile(path, renderProposal(slot), "utf8");
			return { ok: true, path };
		},
	};
}

let sessionRegistry: AgentToolRegistry | undefined;

export function getSessionAgentToolRegistry(): AgentToolRegistry {
	sessionRegistry ??= createAgentToolRegistry();
	return sessionRegistry;
}

export function resetSessionAgentToolRegistryForTest(): void {
	sessionRegistry = createAgentToolRegistry();
}

function validateShape(decl: AgentMadeToolDecl): AgentToolRegistration {
	if (!isNonEmptyString(decl.name) || /[\\/]/.test(decl.name)) return { ok: false, reason: "malformed" };
	if (typeof decl.wraps !== "string" || decl.wraps.trim() === "") return { ok: false, reason: "malformed" };
	if (!isNonEmptyString(decl.purpose)) return { ok: false, reason: "malformed" };
	if (!decl.scope || typeof decl.scope !== "object") return { ok: false, reason: "malformed" };
	if (!Array.isArray(decl.scope.pathPrefixes) || decl.scope.pathPrefixes.some((item) => typeof item !== "string")) {
		return { ok: false, reason: "malformed" };
	}
	if (!Array.isArray(decl.scope.commandHeads) || decl.scope.commandHeads.some((item) => typeof item !== "string")) {
		return { ok: false, reason: "malformed" };
	}
	if (typeof decl.scope.readOnly !== "boolean") return { ok: false, reason: "malformed" };
	return { ok: true, tool: decl };
}

function isWiderThanWrapped(decl: AgentMadeToolDecl): boolean {
	if (decl.scope.pathPrefixes.some((prefix) => isAnchorPath(prefix))) return true;
	return decl.scope.commandHeads.length === 0 && decl.scope.readOnly === false;
}

function matchScope(
	decl: AgentMadeToolDecl,
	input: AgentToolCallInput,
	targetPath: string | undefined,
): { ok: true; matched: AgentToolMatchedScope } | { ok: false } {
	const command = typeof input.command === "string" ? input.command : "";
	const matched: AgentToolMatchedScope = {};

	if (decl.scope.commandHeads.length === 0) {
		if (command.trim() !== "") return { ok: false };
	} else {
		const head = matchingCommandHead(command, decl.scope.commandHeads);
		if (!head) return { ok: false };
		matched.commandHead = head;
	}

	if (decl.scope.readOnly && looksMutating(command)) return { ok: false };

	const path = targetPath ?? input.path;
	if (decl.scope.pathPrefixes.length === 0) {
		if (path && path.trim() !== "") return { ok: false };
	} else if (path && path.trim() !== "") {
		const prefix = matchingPathPrefix(path, decl.scope.pathPrefixes);
		if (!prefix) return { ok: false };
		matched.pathPrefix = prefix;
	}

	return { ok: true, matched };
}

function matchingCommandHead(command: string, heads: readonly string[]): string | undefined {
	const normalized = command.trim().replace(/\s+/g, " ");
	for (const head of heads) {
		const needle = head.trim().replace(/\s+/g, " ");
		if (needle === "") continue;
		if (normalized === needle || normalized.startsWith(`${needle} `)) return head;
	}
	return undefined;
}

function matchingPathPrefix(path: string, prefixes: readonly string[]): string | undefined {
	const normalized = path.replaceAll("\\", "/").toLowerCase();
	for (const prefix of prefixes) {
		const needle = prefix.replaceAll("\\", "/").toLowerCase();
		if (needle === "") continue;
		if (normalized === needle || normalized.startsWith(needle)) return prefix;
	}
	return undefined;
}

function looksMutating(command: string): boolean {
	return /[>]{1,2}/.test(command) || WRITE_MARK.test(command);
}

function evaluateWrapped(
	wraps: string,
	anchorPath: boolean | undefined,
): { decision: "allow" | "deny"; matched: string[] } {
	const destructive = resolveGovernedTool(wraps).destructive;
	return evaluate({
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: wraps },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{
				uid: { type: "Tool", id: wraps },
				attrs: {
					name: wraps,
					destructive,
					...(anchorPath === undefined ? {} : { anchorPath }),
				},
				parents: [],
			},
		],
		...policyEnvelope(),
	});
}

function writeRegisterAudit(
	decl: AgentMadeToolDecl,
	memoryDir: string,
	now: string,
	verdict: "ALLOW" | "DENY",
	rule: string,
): void {
	appendAuditLog(
		{
			ts: now,
			tool: "agent-tool-register",
			verdict,
			rule,
			context: {
				origin: AGENT_TOOL_AUDIT_ORIGIN,
				name: decl.name,
				wraps: decl.wraps,
				purpose: decl.purpose,
				scope: decl.scope,
			},
		},
		memoryDir,
	);
}

function writeCallAudit(
	name: string,
	decl: AgentMadeToolDecl | undefined,
	input: AgentToolCallInput,
	memoryDir: string,
	now: string,
	verdict: "ALLOW" | "DENY",
	rule: string | null,
	matchedScope: AgentToolMatchedScope | undefined,
): void {
	appendAuditLog(
		{
			ts: now,
			tool: name,
			verdict,
			rule,
			context: {
				origin: AGENT_TOOL_AUDIT_ORIGIN,
				wraps: decl?.wraps,
				command: summarize(input.command),
				...(matchedScope ? { matchedScope } : {}),
			},
		},
		memoryDir,
	);
}

function renderProposal(slot: Slot): string {
	const decl = slot.decl;
	const typical = slot.calls
		.slice(-5)
		.map((item) => `- ${item.command}`)
		.join("\n");
	return [
		`# Agent-made tool proposal: ${decl.name}`,
		"",
		"Narrowing wrapper over an existing capability. Not a new power.",
		"Promotion is a Fei human gate: land in governedTools by hand. Never auto-promote.",
		"",
		"## Declaration",
		`- name: ${decl.name}`,
		`- wraps: ${decl.wraps}`,
		`- purpose: ${decl.purpose}`,
		`- scope.pathPrefixes: ${decl.scope.pathPrefixes.join(", ") || "(none)"}`,
		`- scope.readOnly: ${decl.scope.readOnly}`,
		`- scope.commandHeads: ${decl.scope.commandHeads.join(", ") || "(none)"}`,
		"",
		"## Usage in this session",
		`- calls: ${slot.calls.length}`,
		typical ? `- typical:\n${typical}` : "- typical: (none)",
		"",
	].join("\n");
}

function cloneDecl(decl: AgentMadeToolDecl): AgentMadeToolDecl {
	return {
		name: decl.name,
		wraps: decl.wraps,
		purpose: decl.purpose,
		scope: {
			pathPrefixes: [...decl.scope.pathPrefixes],
			readOnly: decl.scope.readOnly,
			commandHeads: [...decl.scope.commandHeads],
		},
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function summarize(command: string): string {
	const trimmed = command.trim();
	return trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}...`;
}
