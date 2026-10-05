import assert from "node:assert/strict";
import test from "node:test";
import { type CuaConnectionOptions, CuaMcpDriver } from "../src/hands/mcp-driver.ts";

test("persistent MCP connections keep one authority context per session and close on end", async () => {
	const opened: CuaConnectionOptions[] = [];
	const closed: number[] = [];
	const called: string[] = [];
	const driver = new CuaMcpDriver(
		{ binary: "cua-driver", defaultTimeoutMs: 5000, socket: "private" },
		async (options) => {
			const id = opened.push(options);
			return {
				call: async (name, input, opts) => {
					called.push(`${id}:${name}:${input.session}`);
					assert.equal(opts.timeout, 5000);
					return { content: [{ type: "text", text: '{"status":"ok"}' }] };
				},
				close: async () => {
					closed.push(id);
				},
			};
		},
	);
	const call = (name: string, session: string) => driver.run(["call", name, JSON.stringify({ session })]);
	await call("list_windows", "one");
	await call("get_browser_state", "one");
	await call("list_windows", "two");
	assert.equal(opened.length, 2);
	assert.equal(opened[0].socket, "private");
	await call("end_session", "one");
	assert.deepEqual(closed, [1]);
	await call("list_windows", "two");
	assert.equal(opened.length, 2);
	assert.deepEqual(called.slice(0, 3), ["1:list_windows:one", "1:get_browser_state:one", "2:list_windows:two"]);
});
test("lost responses close authority and never replay an uncertain action", async () => {
	let calls = 0;
	let closes = 0;
	const driver = new CuaMcpDriver({ binary: "cua-driver", defaultTimeoutMs: 100 }, async () => ({
		call: async () => {
			calls++;
			throw new Error("connection lost");
		},
		close: async () => {
			closes++;
		},
	}));
	const r = await driver.run(["call", "browser_click", '{"session":"owned"}']);
	assert.equal(r.ok, false);
	assert.match(r.stderr, /verify before retrying/);
	assert.equal(calls, 1);
	assert.equal(closes, 1);
});
test("MCP images and error status survive the driver abstraction", async () => {
	const driver = new CuaMcpDriver({ binary: "cua-driver", defaultTimeoutMs: 100 }, async () => ({
		call: async () => ({
			structuredContent: { status: "unknown" },
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		}),
		close: async () => {},
	}));
	const r = await driver.run(["call", "get_window_state", '{"session":"owned"}']);
	assert.equal(JSON.parse(r.stdout).screenshot_png_b64, "aGVsbG8=");
	assert.equal(JSON.parse(r.stdout).status, "unknown");
});
test("pre-aborted MCP calls cannot spawn a driver", async () => {
	let opened = 0;
	const driver = new CuaMcpDriver({ binary: "cua-driver", defaultTimeoutMs: 100 }, async () => {
		opened++;
		throw new Error("unexpected");
	});
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => driver.run(["call", "list_windows", '{"session":"owned"}'], { signal: controller.signal }),
		/abort/i,
	);
	assert.equal(opened, 0);
});
