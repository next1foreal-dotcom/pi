import assert from "node:assert/strict";
import test from "node:test";
import { buildRecallReceipt, UNKNOWN_PROVENANCE } from "../src/her-core/recall-receipts.ts";
import { frontmatter } from "../src/her-core/store.ts";

test("buildRecallReceipt reads provenance frontmatter", () => {
	const note = {
		id: "semantic/moat",
		kind: "semantic",
		path: "semantic/moat.md",
		score: 0.5,
		text: `${frontmatter({
			key: "moat",
			authored_by: "fei",
			harness: "claude-code",
			tier: "exact",
			updated: "2026-07-27",
		})}Memory is the moat.\n`,
	};
	const receipt = buildRecallReceipt(note);
	assert.equal(receipt.slug, "moat");
	assert.equal(receipt.authored_by, "fei");
	assert.equal(receipt.harness, "claude-code");
	assert.equal(receipt.tier, "exact");
	assert.equal(receipt.updated, "2026-07-27");
	assert.match(receipt.excerpt, /Memory is the moat/);
});

test("buildRecallReceipt uses unknown for missing provenance", () => {
	const receipt = buildRecallReceipt({
		id: "world/bare",
		kind: "world",
		path: "world/bare.md",
		score: 1,
		text: "plain body only",
	});
	assert.equal(receipt.authored_by, UNKNOWN_PROVENANCE);
	assert.equal(receipt.harness, UNKNOWN_PROVENANCE);
	assert.equal(receipt.tier, UNKNOWN_PROVENANCE);
	assert.equal(receipt.updated, UNKNOWN_PROVENANCE);
	assert.equal(receipt.slug, "bare");
});

test("buildRecallReceipt redacts secret-shaped excerpts without touching the store", () => {
	const secret = "sk-" + "123456789012345678901234";
	const receipt = buildRecallReceipt({
		id: "world/leak",
		kind: "world",
		path: "world/leak.md",
		score: 1,
		text: `${frontmatter({ key: "leak" })}body with ${secret} still in the note\n`,
	});
	assert.equal(receipt.excerpt.includes(secret), false);
	assert.match(receipt.excerpt, /«REDACTED:secret»/);
});

test("buildRecallReceipt falls back harness to string source", () => {
	const receipt = buildRecallReceipt({
		id: "semantic/x",
		kind: "semantic",
		path: "semantic/x.md",
		score: 1,
		text: `${frontmatter({ key: "x", source: "mcp" })}body\n`,
	});
	assert.equal(receipt.harness, "mcp");
});
