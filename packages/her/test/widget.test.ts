/**
 * G-378 — inline visualization widget (runtime half).
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/widget.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildWidgetMessage } from "../src/her-core/widget.ts";
import { resolveGovernedTool } from "../src/lib/governed-tools.ts";

const TITLE = "flow_chart";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const HTML = '<div class="card"><p>hello</p></div>';
const SECURITY_HINT = /sendPrompt|内联脚本/;

test("buildWidgetMessage accepts SVG and sets mode svg", () => {
	const result = buildWidgetMessage({ title: TITLE, widget_code: SVG });
	assert.equal(result.details.kind, "her-widget");
	assert.equal(result.details.mode, "svg");
	assert.equal(result.details.title, TITLE);
	assert.equal(result.details.widget_code, SVG);
});

test("buildWidgetMessage accepts HTML and sets mode html", () => {
	const result = buildWidgetMessage({ title: TITLE, widget_code: HTML });
	assert.equal(result.details.kind, "her-widget");
	assert.equal(result.details.mode, "html");
	assert.equal(result.details.title, TITLE);
	assert.equal(result.details.widget_code, HTML);
});

test("buildWidgetMessage rejects script tags case-insensitively", () => {
	assert.throws(
		() => buildWidgetMessage({ title: TITLE, widget_code: "<div><script>alert(1)</script></div>" }),
		SECURITY_HINT,
	);
	assert.throws(
		() => buildWidgetMessage({ title: TITLE, widget_code: "<div><SCRIPT src=x></SCRIPT></div>" }),
		SECURITY_HINT,
	);
});

test("buildWidgetMessage rejects inline event handlers", () => {
	assert.throws(
		() => buildWidgetMessage({ title: TITLE, widget_code: '<div onclick="alert(1)">x</div>' }),
		SECURITY_HINT,
	);
	assert.throws(() => buildWidgetMessage({ title: TITLE, widget_code: "<div onload = 'x'>x</div>" }), SECURITY_HINT);
});

test("buildWidgetMessage rejects javascript: URLs", () => {
	assert.throws(
		() => buildWidgetMessage({ title: TITLE, widget_code: '<a href="javascript:alert(1)">x</a>' }),
		SECURITY_HINT,
	);
	assert.throws(
		() => buildWidgetMessage({ title: TITLE, widget_code: '<a href="JAVASCRIPT:alert(1)">x</a>' }),
		SECURITY_HINT,
	);
});

test("buildWidgetMessage rejects foreignObject in SVG mode", () => {
	assert.throws(
		() =>
			buildWidgetMessage({
				title: TITLE,
				widget_code: '<svg><foreignObject width="10" height="10"></foreignObject></svg>',
			}),
		SECURITY_HINT,
	);
});

test("buildWidgetMessage rejects titles that are not snake_case", () => {
	const rule = /snake_case|\^\[a-z\]\[a-z0-9_\]\*/;
	assert.throws(() => buildWidgetMessage({ title: "FlowChart", widget_code: HTML }), rule);
	assert.throws(() => buildWidgetMessage({ title: "flow-chart", widget_code: HTML }), rule);
	assert.throws(() => buildWidgetMessage({ title: "1flow", widget_code: HTML }), rule);
	assert.throws(() => buildWidgetMessage({ title: "_flow", widget_code: HTML }), rule);
	assert.throws(() => buildWidgetMessage({ title: "", widget_code: HTML }), /title|required|snake_case/);
});

test("buildWidgetMessage rejects widget_code over 200000 characters", () => {
	assert.throws(() => buildWidgetMessage({ title: TITLE, widget_code: "x".repeat(200_001) }), /200.?000|200000/);
	const ok = buildWidgetMessage({ title: TITLE, widget_code: "x".repeat(200_000) });
	assert.equal(ok.details.mode, "html");
	assert.equal(ok.details.widget_code.length, 200_000);
});

test("buildWidgetMessage rejects 5 loading_messages and accepts 1..4", () => {
	assert.throws(
		() =>
			buildWidgetMessage({
				title: TITLE,
				widget_code: HTML,
				loading_messages: ["a", "b", "c", "d", "e"],
			}),
		/1|4|loading/,
	);
	assert.throws(
		() =>
			buildWidgetMessage({
				title: TITLE,
				widget_code: HTML,
				loading_messages: ["x".repeat(61)],
			}),
		/60/,
	);
	const four = buildWidgetMessage({
		title: TITLE,
		widget_code: HTML,
		loading_messages: ["a", "b", "c", "d"],
	});
	assert.deepEqual(four.details.loading_messages, ["a", "b", "c", "d"]);
});

test("buildWidgetMessage details pass title, mode, widget_code, and loading_messages through unchanged", () => {
	const widget_code = `  ${SVG}  `;
	const loading_messages = ["drawing chart", "almost there"];
	const result = buildWidgetMessage({ title: TITLE, widget_code, loading_messages });
	assert.deepEqual(result.details, {
		kind: "her-widget",
		title: TITLE,
		mode: "svg",
		widget_code,
		loading_messages,
	});
	assert.equal(result.details.widget_code, widget_code);
	assert.deepEqual(result.details.loading_messages, loading_messages);

	const omitted = buildWidgetMessage({ title: TITLE, widget_code: HTML });
	assert.equal("loading_messages" in omitted.details, false);
	assert.equal(omitted.details.widget_code, HTML);
});

test("buildWidgetMessage content includes title and mode", () => {
	const svg = buildWidgetMessage({ title: TITLE, widget_code: SVG });
	assert.ok(svg.content.includes(TITLE));
	assert.ok(svg.content.includes("svg"));
	assert.equal(svg.content, `[图:${TITLE}] (svg, ${SVG.length} 字符) — 在 Studio 里查看`);

	const html = buildWidgetMessage({ title: TITLE, widget_code: HTML });
	assert.ok(html.content.includes(TITLE));
	assert.ok(html.content.includes("html"));
	assert.equal(html.content, `[图:${TITLE}] (html, ${HTML.length} 字符) — 在 Studio 里查看`);
});

test("her_widget is registered non-destructive so Cedar :6 total permit covers it", () => {
	assert.deepEqual(resolveGovernedTool("her_widget"), { destructive: false, registered: true });
});
