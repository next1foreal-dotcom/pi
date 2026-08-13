import assert from "node:assert/strict";
import test from "node:test";

import { citationHref, resolveCitation } from "../src/compendium/citation.ts";
import type { CitationSource } from "../src/compendium/types.ts";

const catalog: CitationSource[] = [
	{ id: "talk", sourceUrl: "https://www.youtube.com/watch?v=abc" },
	{ id: "essay", sourceUrl: "https://example.test/essay" },
];

test("resolveCitation maps a known source id to the catalog URL and keeps the locator", () => {
	const citation = resolveCitation("essay", "p.12", catalog);
	assert.ok(citation);
	assert.equal(citation.sourceId, "essay");
	assert.equal(citation.sourceUrl, "https://example.test/essay");
	assert.equal(citation.locator, "p.12");
	assert.equal(citation.href, "https://example.test/essay");
});

test("resolveCitation returns null for an unknown source id instead of fabricating a URL", () => {
	assert.equal(resolveCitation("missing", "p.1", catalog), null);
	assert.equal(resolveCitation("", "00:01", catalog), null);
});

test("resolveCitation appends a YouTube timestamp constructed from locator data", () => {
	const citation = resolveCitation("talk", "00:12:03", catalog);
	assert.ok(citation);
	assert.equal(citation.sourceUrl, "https://www.youtube.com/watch?v=abc");
	assert.equal(citation.href, "https://www.youtube.com/watch?v=abc&t=723");
	assert.equal(citationHref("https://youtu.be/abc", "1:02"), "https://youtu.be/abc?t=62");
});

test("citationHref never invents a host; unknown locators keep the catalog URL", () => {
	assert.equal(citationHref("https://example.test/essay", "chapter 4"), "https://example.test/essay");
	assert.equal(
		citationHref("https://www.youtube.com/watch?v=abc", "chars 0-14"),
		"https://www.youtube.com/watch?v=abc",
	);
});
