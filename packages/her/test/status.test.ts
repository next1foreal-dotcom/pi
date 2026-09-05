/**
 * G-425 — session name / headline / waiting (runtime half).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/status.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { applyHerStatus, herStatusParameters } from "../src/her-core/status.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

function objectSchema(schema: unknown): { properties: Record<string, unknown>; required: string[] } {
	assert.ok(schema && typeof schema === "object");
	const record = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
	assert.equal(record.type, "object");
	return {
		properties: record.properties ?? {},
		required: record.required ?? [],
	};
}

function unwrapObject(schema: unknown): { properties: Record<string, unknown>; required: string[] } {
	assert.ok(schema && typeof schema === "object");
	const record = schema as { type?: string; anyOf?: unknown[]; properties?: Record<string, unknown> };
	if (record.type === "object" || record.properties) return objectSchema(schema);
	if (Array.isArray(record.anyOf)) {
		const nested = record.anyOf.find((item) => item && typeof item === "object" && "properties" in item);
		assert.ok(nested, "optional object schema missing object branch");
		return objectSchema(nested);
	}
	return objectSchema(schema);
}

test("her_status is registered non-destructive so Cedar :6 total permit covers it", () => {
	assert.deepEqual(resolveGovernedTool("her_status"), { destructive: false, registered: true });
});

test("her_status schema has optional name, required headline, optional waiting", () => {
	const schema = objectSchema(herStatusParameters);
	assert.ok(schema.properties.name);
	assert.ok(schema.properties.headline);
	assert.ok(schema.properties.waiting);
	assert.deepEqual(schema.required, ["headline"]);
	assert.ok(!schema.required.includes("name"));
	assert.ok(!schema.required.includes("waiting"));

	const name = schema.properties.name as { type?: string };
	const headline = schema.properties.headline as { type?: string };
	assert.equal(name.type, "string");
	assert.equal(headline.type, "string");

	const waiting = unwrapObject(schema.properties.waiting);
	assert.ok(waiting.properties.question);
	assert.ok(waiting.properties.options);
	assert.deepEqual(waiting.required, ["question"]);
	assert.ok(!waiting.required.includes("options"));
	assert.equal((waiting.properties.question as { type?: string }).type, "string");
	const options = waiting.properties.options as { type?: string; items?: { type?: string }; anyOf?: unknown[] };
	if (options.type === "array") {
		assert.equal(options.items?.type, "string");
	} else if (Array.isArray(options.anyOf)) {
		const arr = options.anyOf.find(
			(item) => item && typeof item === "object" && (item as { type?: string }).type === "array",
		) as { items?: { type?: string } } | undefined;
		assert.equal(arr?.items?.type, "string");
	} else {
		assert.fail("waiting.options is not an array schema");
	}
});

test("applyHerStatus truncates overlong fields instead of throwing", () => {
	const name = "名".repeat(30);
	const headline = "头".repeat(80);
	const question = "问".repeat(130);
	const option = "项".repeat(45);
	const options = Array.from({ length: 8 }, (_, i) => `${option}${i}`);

	let result: ReturnType<typeof applyHerStatus>;
	assert.doesNotThrow(() => {
		result = applyHerStatus({
			name,
			headline,
			waiting: { question, options },
		});
	});

	assert.equal(result!.details.name, "名".repeat(24));
	assert.equal(result!.details.headline, "头".repeat(60));
	assert.equal(result!.details.waiting?.question, "问".repeat(120));
	assert.equal(result!.details.waiting?.options?.length, 6);
	for (const item of result!.details.waiting?.options ?? []) {
		assert.ok(item.length <= 40);
	}
	assert.deepEqual(result!.details.truncated, ["name", "headline", "waiting.question", "waiting.options"]);
	assert.match(result!.text, /name/);
	assert.match(result!.text, /headline/);
	assert.match(result!.text, /waiting\.question/);
	assert.match(result!.text, /waiting\.options/);
});

test("applyHerStatus omits name and waiting when they are not given", () => {
	const result = applyHerStatus({ headline: "三个文件都在，正在核对静态引用" });
	assert.equal(result.details.headline, "三个文件都在，正在核对静态引用");
	assert.equal(result.details.name, undefined);
	assert.equal(result.details.waiting, undefined);
	assert.deepEqual(result.details.truncated, []);
	assert.match(result.text, /三个文件都在，正在核对静态引用/);
	assert.doesNotMatch(result.text, /已截断/);
});
