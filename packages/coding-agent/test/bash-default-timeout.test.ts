import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";

/**
 * A command with no timeout used to run forever. On 2026-09-01 one runaway
 * `find` over the whole user profile blocked an agent turn for 16 minutes with
 * zero CPU and zero product — indistinguishable from a hung model (G-417). The
 * tool now applies a default timeout when the model does not pass one, and the
 * model can still pass a larger explicit timeout for legitimately long work.
 */
describe("bash tool default timeout", () => {
	function recordingOps(): { ops: BashOperations; seen: Array<number | undefined> } {
		const seen: Array<number | undefined> = [];
		const ops: BashOperations = {
			exec: async (_command, _cwd, { timeout }) => {
				seen.push(timeout);
				return { exitCode: 0 };
			},
		};
		return { ops, seen };
	}

	const noCtx = undefined as unknown as ExtensionContext;

	it("applies the default when the model omits timeout", async () => {
		const { ops, seen } = recordingOps();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: ops,
			defaultTimeoutSeconds: 123,
			exposeSessionEnvironment: false,
		});
		await tool.execute("t1", { command: "echo hi" }, undefined, undefined, noCtx);
		expect(seen).toEqual([123]);
	});

	it("an explicit timeout wins over the default", async () => {
		const { ops, seen } = recordingOps();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: ops,
			defaultTimeoutSeconds: 123,
			exposeSessionEnvironment: false,
		});
		await tool.execute("t2", { command: "echo hi", timeout: 7 }, undefined, undefined, noCtx);
		expect(seen).toEqual([7]);
	});

	it("ships a non-zero default so a forgotten timeout cannot hang a turn forever", async () => {
		const { ops, seen } = recordingOps();
		const tool = createBashToolDefinition(process.cwd(), { operations: ops, exposeSessionEnvironment: false });
		await tool.execute("t3", { command: "echo hi" }, undefined, undefined, noCtx);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeGreaterThan(0);
	});

	it("defaultTimeoutSeconds: 0 restores the old run-forever behavior on purpose", async () => {
		const { ops, seen } = recordingOps();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: ops,
			defaultTimeoutSeconds: 0,
			exposeSessionEnvironment: false,
		});
		await tool.execute("t4", { command: "echo hi" }, undefined, undefined, noCtx);
		expect(seen).toEqual([undefined]);
	});

	it("a defaulted timeout really kills a hanging command", async () => {
		const tool = createBashToolDefinition(process.cwd(), {
			defaultTimeoutSeconds: 2,
			exposeSessionEnvironment: false,
		});
		const startedAt = Date.now();
		await expect(tool.execute("t5", { command: "sleep 60" }, undefined, undefined, noCtx)).rejects.toThrow(
			/timed out after 2 seconds/,
		);
		expect(Date.now() - startedAt).toBeLessThan(30_000);
	}, 40_000);
});
