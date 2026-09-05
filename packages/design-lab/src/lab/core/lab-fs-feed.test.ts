// @vitest-environment node

/**
 * The canvas notes feed endpoints. A request without `x-lab-canvas` is a CORS
 * simple request any generated page could fire; the server must refuse it,
 * and must stamp `author: "fei"` itself so the browser cannot speak as her.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { labFsPlugin } from "../../../vite-plugin-lab-fs.ts";

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

function attach(projectRoot: string): Middleware {
	const plugin = labFsPlugin(projectRoot);
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

const FEED_REL = ["design", "canvas", "feed.jsonl"] as const;

function feedPath(projectRoot: string): string {
	return path.resolve(projectRoot, "..", "..", ...FEED_REL);
}

describe("POST /__lab-fs/notes/event", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	function boot() {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lab-fs-feed-"));
		dirs.push(repo);
		const projectRoot = path.join(repo, "packages", "design-lab");
		fs.mkdirSync(projectRoot, { recursive: true });
		return { mw: attach(projectRoot), projectRoot, repo };
	}

	it("refuses a write without the x-lab-canvas header", async () => {
		const { mw, projectRoot } = boot();
		const res = await post(mw, "/notes/event", {
			t: "note",
			id: "n_aaaaaaaaaaaa",
			text: "too tight",
			x: 1,
			y: 2,
			screenId: null,
		});
		expect(res.status).toBe(403);
		expect(res.json.ok).toBe(false);
		expect(fs.existsSync(feedPath(projectRoot))).toBe(false);
	});

	it("stamps author as fei even when the body claims samantha", async () => {
		const { mw, projectRoot } = boot();
		const res = await post(
			mw,
			"/notes/event",
			{
				t: "note",
				id: "n_bbbbbbbbbbbb",
				at: "2026-09-05T20:00:00.000Z",
				author: "samantha",
				screenId: "playground",
				x: 10,
				y: 20,
				text: "too tight",
			},
			{ "x-lab-canvas": "1" },
		);
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ ok: true });
		const line = fs.readFileSync(feedPath(projectRoot), "utf8").trim();
		const event = JSON.parse(line) as { author: string; t: string; id: string };
		expect(event.author).toBe("fei");
		expect(event.t).toBe("note");
		expect(event.id).toBe("n_bbbbbbbbbbbb");
	});

	it("rejects an unknown event type with 400 and writes nothing", async () => {
		const { mw, projectRoot } = boot();
		const res = await post(
			mw,
			"/notes/event",
			{ t: "note.explode", id: "n_cccccccccccc", author: "fei" },
			{ "x-lab-canvas": "1" },
		);
		expect(res.status).toBe(400);
		expect(res.json.ok).toBe(false);
		expect(fs.existsSync(feedPath(projectRoot))).toBe(false);
	});

	it("fills at when the body omits it", async () => {
		const { mw, projectRoot } = boot();
		const before = Date.now();
		const res = await post(
			mw,
			"/notes/event",
			{
				t: "note.delete",
				id: "n_dddddddddddd",
			},
			{ "x-lab-canvas": "1" },
		);
		expect(res.status).toBe(200);
		const event = JSON.parse(
			fs.readFileSync(feedPath(projectRoot), "utf8").trim(),
		) as { at: string; author: string };
		expect(event.author).toBe("fei");
		expect(Number.isNaN(Date.parse(event.at))).toBe(false);
		expect(Date.parse(event.at)).toBeGreaterThanOrEqual(before - 1000);
	});
});

describe("POST /__lab-fs/notes/threads", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("returns the raw feed text, or empty when the file is missing", async () => {
		const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lab-fs-threads-"));
		dirs.push(repo);
		const projectRoot = path.join(repo, "packages", "design-lab");
		fs.mkdirSync(projectRoot, { recursive: true });
		const mw = attach(projectRoot);

		const missing = await post(mw, "/notes/threads", {});
		expect(missing.status).toBe(200);
		expect(missing.json).toEqual({ ok: true, feed: "" });

		const file = feedPath(projectRoot);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const raw = '{"t":"note","id":"n_eeeeeeeeeeee"}\n';
		fs.writeFileSync(file, raw);
		const present = await post(mw, "/notes/threads", {});
		expect(present.status).toBe(200);
		expect(present.json).toEqual({ ok: true, feed: raw });
	});
});
