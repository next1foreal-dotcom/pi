import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/nodejs";
import {
	type AuthorizationAnswer,
	checkParseSchema,
	isAuthorized,
	policySetTextToParts,
	policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import { ANCHOR_PATHS, isAllowedSelfModPath, isAnchorPath } from "../rsi/anchors.ts";
import { appendAuditLog } from "./audit.ts";
import { resolveGovernedTool } from "./governed-tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, "..", "..", "pi-package", "policies");
const schemaPath = resolve(policyDir, "her-trust.cedarschema");
const repositoryRoot = resolve(here, "..", "..", "..", "..");

export type CedarProfile = "default" | "heartbeat" | "selfmod";

export const POLICY_TEXT = readPolicyText("default");
export const SCHEMA_TEXT = readFileSync(schemaPath, "utf8");

export interface Verdict {
	decision: "allow" | "deny";
	matched: string[];
}

export interface SelfModToolRequest {
	cwd: string;
	memoryDir: string;
	now?: string;
	targetPath: string;
	toolCallId?: string;
	toolName: string;
}

function parseNamedPolicies(text: string): Record<string, string> {
	const split = policySetTextToParts(text);
	if (split.type !== "success") {
		throw new Error(`failed to split Cedar policy set: ${split.errors.map((error) => error.message).join("; ")}`);
	}
	const named: Record<string, string> = {};
	let auto = 0;
	for (const policyText of split.policies) {
		const parsed = policyToJson(policyText);
		if (parsed.type !== "success") {
			throw new Error(`failed to parse Cedar policy: ${parsed.errors.map((error) => error.message).join("; ")}`);
		}
		const id = parsed.json.annotations?.id ?? `policy${auto++}`;
		named[id] = policyText;
	}
	return named;
}

function assertSchemaParses(schema: string): void {
	const parsed = checkParseSchema(schema);
	if (parsed.type !== "success") {
		throw new Error(`failed to parse Cedar schema: ${parsed.errors.map((error) => error.message).join("; ")}`);
	}
}

export const NAMED_POLICIES = parseNamedPolicies(POLICY_TEXT);
assertSchemaParses(SCHEMA_TEXT);

export function readPolicyText(profile: CedarProfile = selectedProfile()): string {
	const file =
		profile === "heartbeat"
			? "her-trust-heartbeat.cedar"
			: profile === "selfmod"
				? "her-trust-selfmod.cedar"
				: "her-trust.cedar";
	return readFileSync(resolve(policyDir, file), "utf8");
}

export function namedPolicies(profile: CedarProfile = selectedProfile()): Record<string, string> {
	return profile === "default" ? NAMED_POLICIES : parseNamedPolicies(readPolicyText(profile));
}

export function evaluate(call: AuthorizationCall): Verdict {
	const answer: AuthorizationAnswer = isAuthorized(call);
	if (answer.type !== "success") {
		throw new Error(`cedar evaluation failed: ${answer.errors.map((error) => error.message).join("; ")}`);
	}
	return { decision: answer.response.decision, matched: answer.response.diagnostics.reason };
}

export function policyEnvelope(
	profile: CedarProfile = selectedProfile(),
): Pick<AuthorizationCall, "schema" | "validateRequest" | "policies"> {
	return {
		schema: SCHEMA_TEXT,
		validateRequest: true,
		policies: { staticPolicies: namedPolicies(profile) },
	};
}

export function authorizeSelfModTool(request: SelfModToolRequest): Verdict {
	const targetPath = logicalTargetPath(request);
	const anchorPath = isAnchorPath(targetPath);
	const allowedSelfModPath = isAllowedSelfModPath(targetPath);
	const destructive = resolveGovernedTool(request.toolName).destructive;
	const verdict = evaluate({
		principal: { type: "Agent", id: "samantha" },
		action: { type: "Action", id: "CallTool" },
		resource: { type: "Tool", id: request.toolName },
		context: {},
		entities: [
			{ uid: { type: "Agent", id: "samantha" }, attrs: {}, parents: [] },
			{
				uid: { type: "Tool", id: request.toolName },
				attrs: { name: request.toolName, destructive, anchorPath, allowedSelfModPath },
				parents: [],
			},
		],
		...policyEnvelope("selfmod"),
	});
	appendAuditLog(
		{
			ts: request.now ?? new Date().toISOString(),
			tool: request.toolName,
			toolCallId: request.toolCallId,
			verdict: verdict.decision === "allow" ? "ALLOW" : "DENY",
			rule: verdict.matched.join(",") || null,
			context: { targetPath, anchorPath, allowedSelfModPath, profile: "selfmod" },
		},
		request.memoryDir,
	);
	return verdict;
}

/** Resolve a tool-call target the way selfmod does and ask if it is an anchor. */
export function isAnchorTargetPath(request: Pick<SelfModToolRequest, "cwd" | "memoryDir" | "targetPath">): {
	anchorPath: boolean;
	targetPath: string;
} {
	try {
		const targetPath = logicalTargetPath(request);
		return { anchorPath: isAnchorPath(targetPath), targetPath };
	} catch {
		// Fail closed: a path we cannot classify is treated as an anchor.
		return { anchorPath: true, targetPath: request.targetPath };
	}
}

const PATH_FIELD_KEYS = [
	"path",
	"file_path",
	"filePath",
	"target",
	"target_file",
	"targetFile",
	"filename",
	"file",
] as const;

/**
 * Pull a target path out of a tool-call payload. write/edit carry `path`;
 * bash/powershell carry a `command` string — scan that too so forbid_anchor_write
 * sees redirection and Set-Content against SOUL.md.
 */
export function resolveToolCallAnchor(request: {
	cwd: string;
	memoryDir: string;
	input: Record<string, unknown> | undefined;
}): { anchorPath: boolean; targetPath: string } | undefined {
	const input = request.input;
	if (!input) return undefined;

	let recorded: { anchorPath: boolean; targetPath: string } | undefined;
	for (const key of PATH_FIELD_KEYS) {
		const value = input[key];
		if (typeof value !== "string" || value.trim() === "") continue;
		const resolved = isAnchorTargetPath({
			cwd: request.cwd,
			memoryDir: request.memoryDir,
			targetPath: value,
		});
		if (resolved.anchorPath) return resolved;
		recorded ??= resolved;
	}

	if (typeof input.command === "string" && input.command.trim() !== "") {
		const fromCommand = resolveAnchorInCommand(input.command, request);
		if (fromCommand) return fromCommand;
	}
	return recorded;
}

function resolveAnchorInCommand(
	command: string,
	request: { cwd: string; memoryDir: string },
): { anchorPath: boolean; targetPath: string } | undefined {
	for (const candidate of extractPathCandidates(command)) {
		const resolved = isAnchorTargetPath({
			cwd: request.cwd,
			memoryDir: request.memoryDir,
			targetPath: candidate,
		});
		if (resolved.anchorPath) return resolved;
	}
	const mentioned = mentionAnchorPath(command, request.memoryDir);
	if (!mentioned) return undefined;
	return isAnchorTargetPath({
		cwd: request.cwd,
		memoryDir: request.memoryDir,
		targetPath: mentioned,
	});
}

function extractPathCandidates(command: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const trimmed = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
		if (trimmed.length < 3) return;
		if (seen.has(trimmed)) return;
		seen.add(trimmed);
		candidates.push(trimmed);
	};
	for (const match of command.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`/g)) {
		push(match[1] ?? match[2] ?? match[3] ?? "");
	}
	for (const token of command.split(/[\s;|&]+/)) {
		const cleaned = token.replace(/^[<>]+/, "");
		if (/[\\/]/.test(cleaned) || /\.(md|cedar|ts|env)$/i.test(cleaned)) push(cleaned);
	}
	return candidates;
}

function mentionAnchorPath(command: string, memoryDir: string): string | undefined {
	const haystack = command.replaceAll("\\", "/").toLowerCase();
	const memoryRoot = canonicalizeFilesystemPath(resolve(memoryDir)).replaceAll("\\", "/");
	const memoryRelativeAnchors = ["narrative/SOUL.md", "narrative/FACTS.md", "narrative/CONTEXT.md"] as const;
	for (const relativeAnchor of memoryRelativeAnchors) {
		if (haystack.includes(relativeAnchor.toLowerCase())) return `her-memory/${relativeAnchor}`;
	}
	// Computed joins still name the file even when they never emit `narrative/SOUL.md`
	// as one substring (`join('narrative','SOUL.md')`). Not a sandbox — just the
	// remaining lexical hole we can close without denying `echo ok`.
	for (const leaf of ["soul.md", "facts.md", "context.md"] as const) {
		if (new RegExp(`(?:^|[^a-z0-9_-])${leaf}(?:[^a-z0-9_-]|$)`, "i").test(haystack)) {
			return `her-memory/narrative/${leaf === "soul.md" ? "SOUL.md" : leaf === "facts.md" ? "FACTS.md" : "CONTEXT.md"}`;
		}
	}
	if (
		/\b(python3?|py|node|nodejs|pwsh|powershell)\b[\s\S]*\s(?:-c|-e|-enc|-encodedcommand)\b/i.test(command) &&
		haystack.includes("her-memory")
	) {
		return "her-memory/narrative/SOUL.md";
	}
	const needles = [
		...ANCHOR_PATHS,
		"packages/her/src/rsi/anchors.ts",
		...ANCHOR_PATHS.filter((prefix) => prefix.startsWith("her-memory/")).map(
			(prefix) => `${memoryRoot}/${prefix.slice("her-memory/".length)}`,
		),
	];
	for (const needle of needles) {
		const normalized = needle.replaceAll("\\", "/").toLowerCase();
		if (haystack.includes(normalized)) return needle;
	}
	return undefined;
}

/** Strip `\\?\` / `\\?\UNC\` so lexical compare and realpath see the same file. */
function stripWindowsNamespace(raw: string): string {
	const asBackslash = raw.replaceAll("/", "\\");
	if (/^\\\\\?\\UNC\\/i.test(asBackslash)) {
		return `\\\\${asBackslash.slice("\\\\?\\UNC\\".length)}`;
	}
	if (/^\\\\\?\\/i.test(asBackslash)) {
		return asBackslash.slice("\\\\?\\".length);
	}
	return raw;
}

/** Resolve junctions/symlinks/8.3 names on the longest existing prefix. */
function canonicalizeFilesystemPath(absPath: string): string {
	const missing: string[] = [];
	let current = absPath;
	for (;;) {
		try {
			if (existsSync(current)) {
				const real = realpathSync(current);
				return missing.length === 0 ? real : resolve(real, ...missing);
			}
		} catch {
			return absPath;
		}
		const parent = dirname(current);
		if (parent === current) return absPath;
		missing.unshift(basename(current));
		current = parent;
	}
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Match coding-agent path-utils so Cedar sees the same file the tool will write. */
function expandToolPath(raw: string): string {
	let normalized = stripWindowsNamespace(raw.trim()).replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:/i.test(normalized)) {
		try {
			return fileURLToPath(normalized);
		} catch {
			return normalized;
		}
	}
	return normalized;
}

function logicalTargetPath(request: Pick<SelfModToolRequest, "cwd" | "memoryDir" | "targetPath">): string {
	const stripped = expandToolPath(request.targetPath);
	const supplied = stripped.replaceAll("\\", "/");
	if (supplied.toLowerCase().startsWith("her-memory/")) return supplied;
	const absoluteTarget = canonicalizeFilesystemPath(resolve(request.cwd, stripped));
	const memoryRoot = canonicalizeFilesystemPath(resolve(request.memoryDir));
	const memoryPath = relativeWithin(memoryRoot, absoluteTarget);
	if (memoryPath !== null) return `her-memory/${memoryPath}`;
	const repositoryPath = relativeWithin(canonicalizeFilesystemPath(repositoryRoot), absoluteTarget);
	return repositoryPath ?? supplied;
}

function relativeWithin(basePath: string, targetPath: string): string | null {
	const candidate = relative(resolve(basePath), targetPath);
	if (candidate.startsWith("..") || isAbsolute(candidate)) return null;
	return candidate.replaceAll("\\", "/");
}

function selectedProfile(): CedarProfile {
	const profile = process.env.HER_CEDAR_PROFILE;
	return profile === "heartbeat" || profile === "selfmod" ? profile : "default";
}
