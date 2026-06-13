import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AuthorizationAnswer,
	type AuthorizationCall,
	checkParseSchema,
	isAuthorized,
	policySetTextToParts,
	policyToJson,
} from "@cedar-policy/cedar-wasm/nodejs";

const here = dirname(fileURLToPath(import.meta.url));
const policyDir = resolve(here, "..", "..", "pi-package", "policies");
const schemaPath = resolve(policyDir, "her-trust.cedarschema");

export type CedarProfile = "default" | "heartbeat";

export const POLICY_TEXT = readPolicyText("default");
export const SCHEMA_TEXT = readFileSync(schemaPath, "utf8");

export interface Verdict {
	decision: "allow" | "deny";
	matched: string[];
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
	const file = profile === "heartbeat" ? "her-trust-heartbeat.cedar" : "her-trust.cedar";
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

function selectedProfile(): CedarProfile {
	return process.env.HER_CEDAR_PROFILE === "heartbeat" ? "heartbeat" : "default";
}
