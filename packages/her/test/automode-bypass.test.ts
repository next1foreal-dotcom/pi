/**
 * G-425 — her_status must not depend on pi-automode's network classifier.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/automode-bypass.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { applyHerStatus } from "../src/her-core/status.ts";
import {
	bypassesAutoModeClassifier,
	emitToolCallSkippingAutoModeClassifier,
	installHerStatusAutoModeBypass,
	isPiAutomodeExtensionPath,
} from "../src/lib/automode-bypass.ts";

type HandlerResult = { block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown, ctx: unknown) => Promise<HandlerResult> | HandlerResult;

function automodeFailClosedHandler(): Handler {
	return async () => ({
		block: true,
		reason: "Fast classifier failed; auto mode fails closed: fetch failed",
	});
}

function allowHandler(): Handler {
	return () => undefined;
}

function extension(path: string, toolCall: Handler) {
	return {
		path,
		handlers: new Map<string, Handler[]>([["tool_call", [toolCall]]]),
	};
}

async function gateWithClassifier(
	toolName: string,
	execute: () => unknown,
	classify: () => Promise<{ decision: "allow" | "block"; reason: string }>,
): Promise<{ blocked: true; reason: string } | { blocked: false; result: unknown }> {
	if (!bypassesAutoModeClassifier(toolName)) {
		try {
			const decision = await classify();
			if (decision.decision !== "allow") {
				return { blocked: true, reason: decision.reason };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				blocked: true,
				reason: `Fast classifier failed; auto mode fails closed: ${message}`,
			};
		}
	}
	return { blocked: false, result: execute() };
}

test("only her_status bypasses the auto-mode classifier", () => {
	assert.equal(bypassesAutoModeClassifier("her_status"), true);
	assert.equal(bypassesAutoModeClassifier("bash"), false);
	assert.equal(bypassesAutoModeClassifier("write"), false);
	assert.equal(bypassesAutoModeClassifier("her_recall"), false);
	assert.equal(bypassesAutoModeClassifier("read"), false);
});

test("isPiAutomodeExtensionPath matches the preset automode entry, not her", () => {
	assert.equal(
		isPiAutomodeExtensionPath("D:/@Her/fei-pi-preset/node_modules/pi-automode/extensions/auto-mode.ts"),
		true,
	);
	assert.equal(
		isPiAutomodeExtensionPath("D:\\@Her\\fei-pi-preset\\node_modules\\pi-automode\\extensions\\auto-mode.ts"),
		true,
	);
	assert.equal(isPiAutomodeExtensionPath("D:/@Her/Her-repo/samantha/.pi/extensions/her/index.ts"), false);
});

test("her_status still executes when the auto-mode classifier fail-closes", async () => {
	const classifyBoom = async () => {
		throw new Error("fetch failed");
	};

	const status = await gateWithClassifier(
		"her_status",
		() => applyHerStatus({ headline: "分类器挂了也能写状态" }),
		classifyBoom,
	);
	assert.equal(status.blocked, false);
	if (status.blocked) return;
	const result = status.result as ReturnType<typeof applyHerStatus>;
	assert.equal(result.details.headline, "分类器挂了也能写状态");

	const bash = await gateWithClassifier("bash", () => ({ text: "should not run" }), classifyBoom);
	assert.equal(bash.blocked, true);
	if (!bash.blocked) return;
	assert.match(bash.reason, /fetch failed/);
	assert.match(bash.reason, /fails closed/);
});

test("emitToolCallSkippingAutoModeClassifier skips automode and still runs her", async () => {
	const automode = extension(
		"D:/@Her/fei-pi-preset/node_modules/pi-automode/extensions/auto-mode.ts",
		automodeFailClosedHandler(),
	);
	const herExt = extension("D:/@Her/Her-repo/samantha/.pi/extensions/her/index.ts", allowHandler());
	const event = { type: "tool_call", toolName: "her_status", toolCallId: "t1", input: { headline: "x" } };

	const blocked = await emitToolCallSkippingAutoModeClassifier(event, [herExt, automode], {});
	assert.equal(blocked, undefined);
	const executed = applyHerStatus({ headline: "x" });
	assert.equal(executed.details.headline, "x");
});

test("installed bypass lets her_status through emitToolCall when automode would fail-close", async () => {
	installHerStatusAutoModeBypass();
	const automode = extension(
		"D:/@Her/fei-pi-preset/node_modules/pi-automode/extensions/auto-mode.ts",
		automodeFailClosedHandler(),
	);
	const herExt = extension("D:/@Her/Her-repo/samantha/.pi/extensions/her/index.ts", allowHandler());
	const runner = {
		extensions: [herExt, automode],
		createContext() {
			return {};
		},
	};
	const herStatusEvent = {
		type: "tool_call" as const,
		toolName: "her_status",
		toolCallId: "t-status",
		input: { headline: "真路径" },
	};
	const bashEvent = {
		type: "tool_call" as const,
		toolName: "bash",
		toolCallId: "t-bash",
		input: { command: "echo hi" },
	};

	const statusVerdict = await ExtensionRunner.prototype.emitToolCall.call(runner, herStatusEvent);
	assert.equal(statusVerdict, undefined);
	const executed = applyHerStatus({ headline: "真路径" });
	assert.equal(executed.details.headline, "真路径");

	const bashVerdict = await ExtensionRunner.prototype.emitToolCall.call(runner, bashEvent);
	assert.equal(bashVerdict?.block, true);
	assert.match(String(bashVerdict?.reason), /fetch failed/);
});
