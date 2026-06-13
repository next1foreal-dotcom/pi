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
const policyPath = resolve(policyDir, "her-trust.cedar");
const schemaPath = resolve(policyDir, "her-trust.cedarschema");

export const POLICY_TEXT = readFileSync(policyPath, "utf8");
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

export function evaluate(call: AuthorizationCall): Verdict {
	const answer: AuthorizationAnswer = isAuthorized(call);
	if (answer.type !== "success") {
		throw new Error(`cedar evaluation failed: ${answer.errors.map((error) => error.message).join("; ")}`);
	}
	return { decision: answer.response.decision, matched: answer.response.diagnostics.reason };
}

export function policyEnvelope(): Pick<AuthorizationCall, "schema" | "validateRequest" | "policies"> {
	return {
		schema: SCHEMA_TEXT,
		validateRequest: true,
		policies: { staticPolicies: NAMED_POLICIES },
	};
}
