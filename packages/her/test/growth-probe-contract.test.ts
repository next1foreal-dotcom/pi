import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	type ProbeInputContract,
	type ProbeOperation,
	renderProbeOperations,
	validateProbeAction,
	validateProbeContracts,
} from "../src/growth-experiment/probe-contract.ts";

// Synthetic protocol shapes; no learned method, expected task output, or model reply is supplied.
const contract: ProbeInputContract = {
	version: 1,
	discriminator: "kind",
	variants: {
		"git-status": {
			checkoutAutocrlf: { type: "boolean" },
			readerConfig: { type: "string", values: ["inherit", "sanitized"] },
			newline: { type: "string", values: ["LF", "CRLF"] },
			content: { type: "string", optional: true, maxLength: 12000 },
		},
		"text-pair": {
			left: { type: "string", maxLength: 12000 },
			right: { type: "string", maxLength: 12000 },
			rule: { type: "string", values: ["literal", "normalize-lf", "case-insensitive"] },
		},
		"binary-pair": {
			leftHex: { type: "string", maxLength: 12000, format: "hex-bytes" },
			rightHex: { type: "string", maxLength: 12000, format: "hex-bytes" },
		},
	},
	batch: { key: "cases", maxItems: 4 },
};
const operations: Record<string, ProbeOperation> = {
	"observe-environment": { purposes: ["probe"], description: "Read bounded facts", probeInputContract: contract },
	"judge-only": { purposes: ["review"], description: "Must not be exposed as a probe" },
};
const single = { kind: "git-status", checkoutAutocrlf: true, readerConfig: "inherit", newline: "LF" };
const wire = (input: unknown, operationId = "observe-environment") => JSON.stringify({ operationId, input });
const errors = (raw: unknown) => {
	const verdict = validateProbeAction(raw, operations);
	assert.equal(verdict.ok, false);
	if (verdict.ok) throw new Error("unexpected accept");
	return verdict.issues;
};

test("catalog separates executable IDs from discriminators; no private script or final cases", () => {
	const extended = {
		...operations,
		"observe-environment": {
			...operations["observe-environment"],
			file: "PRIVATE_SCRIPT",
			expected: "SECRET_ANSWER",
		},
	};
	const rendered = renderProbeOperations(extended);
	const catalog = JSON.parse(rendered.split("\n").at(-1)!);
	assert.deepEqual(catalog.allowedOperationIds, ["observe-environment"]);
	assert.deepEqual(catalog.operations[0].inputContract, contract);
	assert.doesNotMatch(rendered, /PRIVATE_SCRIPT|SECRET_ANSWER|judge-only/);
	assert.match(rendered, /every case is a complete input/);
});
test("valid single input is unchanged and is only shape-valid", () => {
	const raw = wire(single);
	const copy = JSON.stringify(operations);
	const verdict = validateProbeAction(raw, operations);
	assert.equal(verdict.ok, true);
	if (verdict.ok) assert.deepEqual(verdict.action, JSON.parse(raw));
	assert.equal(JSON.stringify(operations), copy);
});
test("historical Pilot 01 action remains rejected without rewriting", () => {
	const history = JSON.parse(
		readFileSync(new URL("./fixtures/growth-probe-pilot01-action.json", import.meta.url), "utf8"),
	);
	const before = history.action;
	const issue = errors(before)[0];
	assert.equal(issue.code, "unknown-operation");
	assert.equal(issue.path, "action.operationId");
	assert.equal(issue.expected, "observe-environment");
	assert.equal(history.action, before);
});
test("a test-only envelope with the right tool still needs kind on EVERY case", () => {
	const issues = errors(
		wire({
			cases: [
				{ checkoutAutocrlf: true, readerConfig: "inherit", newline: "CRLF" },
				{ ...single },
				{ checkoutAutocrlf: false, readerConfig: "inherit", newline: "LF" },
			],
		}),
	);
	assert.deepEqual(
		issues.map((i) => i.path),
		["action.input.cases[0].kind", "action.input.cases[2].kind"],
	);
});
test("valid batch accepted without expanding it into host actions", () => {
	const raw = wire({ cases: [single, { ...single, checkoutAutocrlf: false }] });
	const result = validateProbeAction(raw, operations);
	assert.ok(result.ok);
	assert.deepEqual(result.action, JSON.parse(raw));
});
test("no alias: input kind is not an executable ID", () => {
	assert.equal(errors(wire(single, "git-status"))[0].code, "unknown-operation");
	assert.equal(errors(wire(single, "Observe-environment"))[0].code, "unknown-operation");
});
test("review-only operation cannot become a probe", () => {
	assert.equal(errors(wire(single, "judge-only"))[0].code, "unknown-operation");
});
test("missing required fields identified, booleans never coerced", () => {
	assert.equal(errors(wire({ kind: "git-status" }))[0].code, "required-field");
	assert.equal(errors(wire({ ...single, checkoutAutocrlf: "true" }))[0].code, "field-type");
	assert.equal(errors(wire({ ...single, readerConfig: "fix-it" }))[0].code, "field-enum");
});
test("unknown extra fields and nested batches rejected", () => {
	assert.equal(errors(wire({ ...single, shell: "do something" }))[0].code, "unexpected-fields");
	assert.equal(errors(wire({ cases: [{ cases: [single] }] }))[0].code, "invalid-discriminator");
});
test("empty/oversized batch and sibling fields rejected", () => {
	for (const input of [{ cases: [] }, { cases: Array(5).fill(single) }, { cases: [single], ...single }])
		assert.equal(errors(wire(input))[0].code, "invalid-batch");
});
test("binary requires even nonempty hexadecimal without executing a decoder", () => {
	for (const leftHex of ["f", "", "zz", "0".repeat(12002)]) {
		const issue = errors(wire({ kind: "binary-pair", leftHex, rightHex: "ff" }))[0];
		assert.ok(issue.code === "field-format" || issue.code === "field-size");
	}
	assert.ok(
		validateProbeAction(wire({ kind: "binary-pair", leftHex: "ff000d0a", rightHex: "ff000a" }), operations).ok,
	);
});
test("bad JSON, objects, arrays and oversized strings refused", () => {
	for (const raw of ["{", "null", "[]", JSON.stringify({ operationId: "observe-environment" }), {}, " ".repeat(64001)])
		assert.equal(validateProbeAction(raw, operations).ok, false);
});
test("envelope accepts only operationId and object input", () => {
	for (const input of [null, [], "text"]) assert.equal(errors(wire(input))[0].code, "invalid-envelope");
	assert.equal(
		errors(JSON.stringify({ operationId: "observe-environment", input: single, command: "oops" }))[0].code,
		"invalid-envelope",
	);
});
test("undeclared legacy contract remains visibly undeclared, with old tool scope checks", () => {
	const legacy = { old: { purposes: ["probe"] } };
	assert.ok(validateProbeAction(wire({ opaque: [1, 2] }, "old"), legacy).ok);
	assert.match(renderProbeOperations(legacy), /"inputContract":null/);
	assert.equal(validateProbeAction(wire({}, "different"), legacy).ok, false);
});
test("owner contract validation fails before rendering, rather than silently weakening it", () => {
	const bads = [
		{ ...contract, version: 2 },
		{ ...contract, variants: {} },
		{ ...contract, batch: { key: "kind", maxItems: 4 } },
		{ ...contract, batch: { key: "cases", maxItems: 0 } },
		{ ...contract, discriminator: "constructor" },
		{ ...contract, variants: { sample: { kind: { type: "string" } } } },
		{ ...contract, variants: { sample: { field: { type: "number" } } } },
		{ ...contract, variants: { sample: { field: { type: "boolean", values: ["true"] } } } },
		{ ...contract, variants: { sample: { field: { type: "string", values: [] } } } },
		{ ...contract, variants: { sample: { field: { type: "string", maxLength: -1 } } } },
		{ ...contract, variants: { sample: { field: { type: "string", format: "shell" } } } },
		{ ...contract, unknownAuthority: true },
	];
	for (const c of bads) {
		const bad = { op: { purposes: ["probe"], probeInputContract: c as ProbeInputContract } };
		assert.throws(() => validateProbeContracts(bad), /invalid|unsupported/);
		assert.throws(() => renderProbeOperations(bad), /invalid|unsupported/);
	}
});
test("prototype names cannot name tools, variants, or fields", () => {
	assert.throws(() => validateProbeContracts(JSON.parse('{"__proto__":{"purposes":["probe"]}}')), /invalid/);
	assert.equal(errors(wire(single, "toString"))[0].code, "unknown-operation");
});
test("diagnostics never echo untrusted payload values", () => {
	const issues = errors(wire({ ...single, readerConfig: "Bearer private-value", hiddenSecret: "private-value" }));
	assert.doesNotMatch(JSON.stringify(issues), /Bearer|private-value|hiddenSecret/);
});
test("optional field must be typed when present; missing optional is valid", () => {
	assert.ok(validateProbeAction(wire(single), operations).ok);
	assert.equal(errors(wire({ ...single, content: null }))[0].code, "field-type");
});
