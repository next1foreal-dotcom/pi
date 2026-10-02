import assert from "node:assert/strict";
import test from "node:test";
import { isModelProbeEcho } from "../src/growth-experiment/model.ts";

const nonce = "2be0c870-7533-4378-8297-a4b261f752ab";
test("probe validates the exact JSON challenge", () => {
	assert.equal(isModelProbeEcho(JSON.stringify({ probe: nonce }), nonce), true);
});
test("probe accepts insignificant JSON whitespace", () => {
	assert.equal(isModelProbeEcho(`  { "probe" : "${nonce}" }\n`, nonce), true);
});
for (const [name, reply] of [
	["old challenge", '{"probe":"previous"}'],
	["extra key", JSON.stringify({ probe: nonce, ok: true })],
	["array", JSON.stringify([{ probe: nonce }])],
	["null", "null"],
	["string", JSON.stringify(nonce)],
	["number", "12"],
	["empty object", "{}"],
	["invalid JSON", "not-json"],
	["markdown fence", `\u0060\u0060\u0060json\n${JSON.stringify({ probe: nonce })}\n\u0060\u0060\u0060`],
	["wrong value type", '{"probe":true}'],
] as const) {
	test(`probe rejects ${name}`, () => {
		assert.equal(isModelProbeEcho(reply, nonce), false);
	});
}
