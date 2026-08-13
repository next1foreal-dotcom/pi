import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorizationCall } from "@cedar-policy/cedar-wasm/nodejs";
import {
	type AuthorizationAnswer,
	checkParseSchema,
	isAuthorized,
	policySetTextToParts,
	policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";
import { isAllowedSelfModPath, isAnchorPath } from "../rsi/anchors.ts";
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
	const targetPath = logicalTargetPath(request);
	return { anchorPath: isAnchorPath(targetPath), targetPath };
}

function logicalTargetPath(request: Pick<SelfModToolRequest, "cwd" | "memoryDir" | "targetPath">): string {
	const supplied = request.targetPath.replaceAll("\\", "/");
	if (supplied.toLowerCase().startsWith("her-memory/")) return supplied;
	const absoluteTarget = resolve(request.cwd, request.targetPath);
	const memoryPath = relativeWithin(request.memoryDir, absoluteTarget);
	if (memoryPath !== null) return `her-memory/${memoryPath}`;
	const repositoryPath = relativeWithin(repositoryRoot, absoluteTarget);
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
