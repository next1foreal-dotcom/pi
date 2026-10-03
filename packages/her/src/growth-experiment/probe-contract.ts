/**
 * Bounded shape contract for host-owned probe inputs, not a general JSON Schema
 * engine, permission grant, semantic validator, or OS sandbox.
 */
export type ProbeField =
	| { type: "boolean"; optional?: boolean }
	| { type: "string"; optional?: boolean; values?: readonly string[]; maxLength?: number; format?: "hex-bytes" };

export interface ProbeInputContract {
	version: 1;
	discriminator: string;
	variants: Record<string, Record<string, ProbeField>>;
	batch?: { key: string; maxItems: number };
}
export interface ProbeOperation {
	purposes: readonly string[];
	description?: string;
	probeInputContract?: ProbeInputContract;
}
export interface ProbeIssue {
	code: string;
	path: string;
	expected: string;
}
export type ProbeValidation =
	| { ok: true; action: { operationId: string; input: Record<string, unknown> } }
	| { ok: false; issues: ProbeIssue[] };

const safeName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}
function validName(value: unknown): value is string {
	return typeof value === "string" && safeName.test(value) && !forbidden.has(value);
}

/** Validate owner-supplied contracts before a plan is frozen or a model is called. */
export function validateProbeContracts(operations: Record<string, ProbeOperation>): void {
	if (!object(operations) || Object.keys(operations).length > 64) throw new Error("invalid probe catalog");
	for (const [id, op] of Object.entries(operations)) {
		if (
			!/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
			forbidden.has(id) ||
			!object(op) ||
			!Array.isArray(op.purposes) ||
			!op.purposes.every((purpose) => typeof purpose === "string")
		)
			throw new Error("invalid probe operation");
		const c = op.probeInputContract;
		if (c === undefined) continue; // Existing frozen plans are not silently rewritten.
		if (
			!object(c) ||
			!exactKeys(c, ["version", "discriminator", "variants", "batch"]) ||
			c.version !== 1 ||
			!validName(c.discriminator) ||
			!object(c.variants) ||
			Object.keys(c.variants).length < 1 ||
			Object.keys(c.variants).length > 16
		)
			throw new Error("invalid probe input contract");
		if (
			c.batch !== undefined &&
			(!object(c.batch) ||
				!exactKeys(c.batch, ["key", "maxItems"]) ||
				!validName(c.batch.key) ||
				c.batch.key === c.discriminator ||
				!Number.isSafeInteger(c.batch.maxItems) ||
				c.batch.maxItems < 1 ||
				c.batch.maxItems > 16)
		)
			throw new Error("invalid probe batch contract");
		for (const [variant, fields] of Object.entries(c.variants)) {
			if (!validName(variant) || !object(fields) || Object.keys(fields).length > 32)
				throw new Error("invalid probe variant");
			for (const [name, f] of Object.entries(fields)) {
				if (
					!validName(name) ||
					name === c.discriminator ||
					name === c.batch?.key ||
					!object(f) ||
					!exactKeys(f, ["type", "optional", "values", "maxLength", "format"]) ||
					(f.optional !== undefined && typeof f.optional !== "boolean")
				)
					throw new Error("invalid probe field");
				if (f.type === "boolean") {
					if (!exactKeys(f, ["type", "optional"])) throw new Error("invalid boolean probe field");
				} else if (f.type === "string") {
					if (
						f.maxLength !== undefined &&
						(!Number.isSafeInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 65536)
					)
						throw new Error("invalid probe text limit");
					if (f.format !== undefined && f.format !== "hex-bytes") throw new Error("invalid probe text format");
					if (
						f.values !== undefined &&
						(!Array.isArray(f.values) ||
							f.values.length < 1 ||
							f.values.length > 32 ||
							new Set(f.values).size !== f.values.length ||
							!f.values.every((v) => typeof v === "string" && v.length <= (f.maxLength ?? 65536)))
					)
						throw new Error("invalid probe enum");
				} else throw new Error("unsupported probe field type");
			}
		}
	}
}

/** Public tool contract only: never includes script paths, answer keys, or final cases. */
export function renderProbeOperations(operations: Record<string, ProbeOperation>): string {
	validateProbeContracts(operations);
	const catalog = Object.entries(operations)
		.filter(([, op]) => op.purposes.includes("probe"))
		.map(([operationId, op]) => ({
			operationId,
			description: op.description ?? "host-approved operation",
			inputContract: op.probeInputContract ?? null,
		}));
	return [
		"Probe wire format: probe.action is a JSON-encoded STRING containing exactly operationId and input.",
		"operationId selects the executable tool; copy an exact operationId from allowedOperationIds.",
		"An input discriminator such as kind selects data within that tool; it is NOT an operationId.",
		"For a declared batch, every case is a complete input and includes its own discriminator.",
		"All declared fields are required unless optional=true. Extra fields and nested batches are rejected.",
		"null inputContract means shape details are undeclared, not unrestricted execution.",
		"Describe an experiment and its predictions yourself; this catalog supplies no hypothesis or answer.",
		JSON.stringify({ allowedOperationIds: catalog.map((op) => op.operationId), operations: catalog }),
	].join("\n");
}

function validateItem(value: unknown, c: ProbeInputContract, path: string): ProbeIssue[] {
	const issues: ProbeIssue[] = [];
	if (!object(value)) return [{ code: "input-object-required", path, expected: "object" }];
	const kind = value[c.discriminator];
	if (typeof kind !== "string" || !Object.hasOwn(c.variants, kind))
		return [
			{
				code: "invalid-discriminator",
				path: `${path}.${c.discriminator}`,
				expected: Object.keys(c.variants).join("|"),
			},
		];
	const fields = c.variants[kind];
	if (!exactKeys(value, [c.discriminator, ...Object.keys(fields)]))
		issues.push({ code: "unexpected-fields", path, expected: "only declared fields" });
	for (const [name, f] of Object.entries(fields)) {
		if (!Object.hasOwn(value, name)) {
			if (f.optional !== true) issues.push({ code: "required-field", path: `${path}.${name}`, expected: f.type });
			continue;
		}
		const v = value[name];
		if (typeof v !== f.type) issues.push({ code: "field-type", path: `${path}.${name}`, expected: f.type });
		else if (f.type === "string" && typeof v === "string") {
			if (v.length > (f.maxLength ?? 65536))
				issues.push({ code: "field-size", path: `${path}.${name}`, expected: `length <= ${f.maxLength ?? 65536}` });
			if (f.values && !f.values.includes(v))
				issues.push({ code: "field-enum", path: `${path}.${name}`, expected: f.values.join("|") });
			if (f.format === "hex-bytes" && !/^(?:[0-9a-fA-F]{2})+$/.test(v))
				issues.push({
					code: "field-format",
					path: `${path}.${name}`,
					expected: "nonempty even-length hexadecimal",
				});
		}
	}
	return issues;
}

/**
 * No coercion, aliases, default kind, repair, execution, or model calls.
 * Valid means shape-valid only; the existing grant/sealed-case checks still apply.
 */
export function validateProbeAction(actionText: unknown, operations: Record<string, ProbeOperation>): ProbeValidation {
	validateProbeContracts(operations);
	if (typeof actionText !== "string" || Buffer.byteLength(actionText, "utf8") > 64000)
		return {
			ok: false,
			issues: [{ code: "action-string-required", path: "action", expected: "JSON string <= 64000 bytes" }],
		};
	let raw: unknown;
	try {
		raw = JSON.parse(actionText);
	} catch {
		return { ok: false, issues: [{ code: "invalid-json", path: "action", expected: "one JSON object" }] };
	}
	if (
		!object(raw) ||
		!exactKeys(raw, ["operationId", "input"]) ||
		typeof raw.operationId !== "string" ||
		!object(raw.input)
	)
		return {
			ok: false,
			issues: [{ code: "invalid-envelope", path: "action", expected: "exactly {operationId:string,input:object}" }],
		};
	const ids = Object.keys(operations).filter((id) => operations[id].purposes.includes("probe"));
	if (!ids.includes(raw.operationId))
		return {
			ok: false,
			issues: [{ code: "unknown-operation", path: "action.operationId", expected: ids.join("|") }],
		};
	const c = operations[raw.operationId].probeInputContract;
	let issues: ProbeIssue[] = [];
	if (c) {
		if (c.batch && Object.hasOwn(raw.input, c.batch.key)) {
			const items = raw.input[c.batch.key];
			if (
				!exactKeys(raw.input, [c.batch.key]) ||
				!Array.isArray(items) ||
				items.length < 1 ||
				items.length > c.batch.maxItems
			)
				issues = [
					{
						code: "invalid-batch",
						path: `action.input.${c.batch.key}`,
						expected: `1..${c.batch.maxItems} complete inputs; no sibling fields`,
					},
				];
			else issues = items.flatMap((item, i) => validateItem(item, c, `action.input.${c.batch!.key}[${i}]`));
		} else issues = validateItem(raw.input, c, "action.input");
	}
	if (issues.length) return { ok: false, issues: issues.slice(0, 16) };
	return { ok: true, action: { operationId: raw.operationId, input: raw.input } };
}
