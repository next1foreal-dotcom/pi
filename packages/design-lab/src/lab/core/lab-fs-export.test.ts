// @vitest-environment node

/**
 * POST /__lab-fs/export writes the same files design_lab_export writes.
 * A request without x-lab-canvas is a CORS simple request any generated
 * page could fire, so the server must refuse it rather than mint a PNG
 * of whoever asked.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunLabExportInput, RunLabExportOutput } from "../../../her/src/preview/lab-export.ts";
import { labFsPlugin } from "../../../vite-plugin-lab-fs.ts";
import { labFs } from "./fs-client.ts";

type Req = EventEmitter & {
	method?: string;
	url?: string;
	headers: Record<string, string | undefined>;
};

class FakeRes {
	statusCode = 0;
	headers: Record<string, string> = {};
	body = "";
	private finish!: () => void;
	readonly done = new Promise<void>((resolve) => {
		this.finish = resolve;
	});
	setHeader(name: string, value: string) {
		this.headers[name] = value;
	}
	end(chunk?: string) {
		this.body = chunk ?? "";
		this.finish();
	}
}

type Middleware = (req: Req, res: FakeRes, next: () => void) => void;

function attach(
	projectRoot: string,
	runExport: (input: RunLabExportInput) => Promise<RunLabExportOutput>,
): Middleware {
	const plugin = labFsPlugin(projectRoot, { runExport });
	let middleware: Middleware | undefined;
	const hook = plugin.configureServer;
	if (typeof hook !== "function") {
		throw new Error("labFsPlugin must expose configureServer as a function");
	}
	const install = hook as unknown as (server: {
		watcher: { add(): void; on(): void };
		ws: { send(): void };
		middlewares: { use(path: string, fn: Middleware): void };
	}) => void;
	install({
		watcher: { add() {}, on() {} },
		ws: { send() {} },
		middlewares: {
			use(_path: string, fn: Middleware) {
				middleware = fn;
			},
		},
	});
	if (!middleware) throw new Error("middleware not installed");
	return middleware;
}

async function post(
	mw: Middleware,
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
) {
	const req = new EventEmitter() as Req;
	req.method = "POST";
	req.url = url;
	req.headers = headers;
	const res = new FakeRes();
	mw(req, res, () => {
		throw new Error("next() should not be called for POST");
	});
	req.emit("data", Buffer.from(JSON.stringify(body)));
	req.emit("end");
	await Promise.race([
		res.done,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`timed out waiting for ${url}`)), 2000),
		),
	]);
	return {
		status: res.statusCode,
		json: JSON.parse(res.body) as Record<string, unknown>,
	};
}

describe("POST /__lab-fs/export", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	function boot(runExport: (input: RunLabExportInput) => Promise<RunLabExportOutput>) {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lab-fs-export-"));
		dirs.push(repo);
		const projectRoot = path.join(repo, "packages", "design-lab");
		fs.mkdirSync(projectRoot, { recursive: true });
		return { mw: attach(projectRoot, runExport), projectRoot, repo };
	}

	it("refuses a write without the x-lab-canvas header", async () => {
		let called = false;
		const { mw } = boot(async () => {
			called = true;
			return { ok: true, text: "no", details: { ok: true } };
		});
		const res = await post(mw, "/export", { format: "png" });
		expect(res.status).toBe(403);
		expect(res.json.ok).toBe(false);
		expect(called).toBe(false);
	});

	it("hands the asked-for screens and format to the shared writer", async () => {
		const seen: RunLabExportInput[] = [];
		const { mw, repo } = boot(async (input) => {
			seen.push(input);
			return {
				ok: true,
				text: "Wrote 1 file to design/exports:\n- loora-landing.png",
				details: { ok: true, files: ["loora-landing.png"], format: "png" },
			};
		});
		const res = await post(
			mw,
			"/export",
			{ screenIds: ["loora-landing"], format: "png" },
			{ "x-lab-canvas": "1" },
		);
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ ok: true, files: ["loora-landing.png"] });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.screenIds).toEqual(["loora-landing"]);
		expect(seen[0]?.format).toBe("png");
		expect(seen[0]?.repoRoot).toBe(repo);
	});

	it("a capture that fails is reported, not swallowed", async () => {
		const { mw } = boot(async () => ({
			ok: false,
			text: "Could not export: lab is not running",
			details: { ok: false },
		}));
		const res = await post(mw, "/export", {}, { "x-lab-canvas": "1" });
		expect(res.status).toBe(400);
		expect(res.json.ok).toBe(false);
		expect(res.json.error).toMatch(/lab is not running/);
	});
});

describe("labFs.export", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the canvas guard", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ ok: true, files: ["loora-landing.png"] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetch);
		await labFs.export({ screenIds: ["loora-landing"], format: "png" });
		expect(fetch).toHaveBeenCalledTimes(1);
		const init = fetch.mock.calls[0]?.[1] as { headers?: Record<string, string> };
		expect(init.headers?.["x-lab-canvas"]).toBe("1");
	});
});
