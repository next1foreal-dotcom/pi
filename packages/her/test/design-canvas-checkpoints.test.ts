/**
 * Each canvas speech event remembers the git HEAD it was written against.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/design-canvas-checkpoints.test.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { labFsPlugin } from "../../design-lab/vite-plugin-lab-fs.ts";
import type { CanvasEvent } from "../src/design-canvas/feed.ts";
import { parseFeed, projectThreads, serializeEvent } from "../src/design-canvas/feed.ts";
import { appendEvent, feedPath, resetHeadCacheForTest } from "../src/design-canvas/store.ts";
import { commitsSinceNote, registerDesignVersionTools } from "../src/design-versions/index.ts";
import { SAMANTHA_REPO_ROOT } from "../src/her-core/channel-probe-gate.ts";

const AT = "2026-09-06T12:00:00.000Z";
const GIT_TIMEOUT_MS = 15_000;
const FORGED_OID = "ffffffffffffffffffffffffffffffffffffffff";

function gitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_COMMON_DIR",
		"GIT_NOTES_REF",
	]) {
		delete env[key];
	}
	return env;
}

function samanthaHead(): string {
	const result = spawnSync("git", ["-C", SAMANTHA_REPO_ROOT, "rev-parse", "HEAD"], {
		encoding: "utf8",
		env: gitEnv(),
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr);
	const oid = result.stdout.trim();
	assert.ok(oid.length > 0);
	return oid;
}

function tempRoot(t: test.TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "her-canvas-cp-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function note(id: string, extra: Partial<CanvasEvent> = {}): CanvasEvent {
	return {
		t: "note",
		id,
		at: AT,
		author: "fei",
		screenId: "product-list",
		x: 10,
		y: 20,
		text: "too tight",
		...extra,
	} as CanvasEvent;
}

function lastLine(root: string): Record<string, unknown> {
	const text = readFileSync(feedPath(root), "utf8").trim();
	const line = text.split("\n").at(-1);
	assert.ok(line);
	return JSON.parse(line) as Record<string, unknown>;
}

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
	if (typeof hook !== "function") throw new Error("labFsPlugin must expose configureServer");
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
): Promise<{ status: number; json: Record<string, unknown> }> {
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
		new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${url}`)), 2000)),
	]);
	return { status: res.statusCode, json: JSON.parse(res.body) as Record<string, unknown> };
}

function pluginFeedPath(projectRoot: string): string {
	return join(projectRoot, "..", "..", "design", "canvas", "feed.jsonl");
}

function git(repo: string, args: string[]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], {
		encoding: "utf8",
		env: gitEnv(),
		timeout: GIT_TIMEOUT_MS,
		windowsHide: true,
	});
	const extra = result.error ? result.error.message : "";
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: `${result.stderr ?? ""}${extra}`,
	};
}

async function initRepo(t: test.TestContext, subjects: string[]): Promise<{ repo: string; oids: string[] }> {
	const repo = tempRoot(t);
	assert.equal(git(repo, ["init", "-b", "main", "--quiet"]).status, 0);
	assert.equal(git(repo, ["config", "user.name", "her-test"]).status, 0);
	assert.equal(git(repo, ["config", "user.email", "her-test@example.com"]).status, 0);
	for (const subject of subjects) {
		const committed = git(repo, ["commit", "--allow-empty", "--no-verify", "-m", subject]);
		assert.equal(committed.status, 0, committed.stderr);
	}
	const logged = git(repo, ["log", "--reverse", "--format=%H"]);
	assert.equal(logged.status, 0, logged.stderr);
	const oids = logged.stdout.split(/\r?\n/).filter((line) => line.length > 0);
	assert.equal(oids.length, subjects.length);
	return { repo, oids };
}

function harness(repoRoot: string): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	registerDesignVersionTools(pi, { repoRoot });
	return tools;
}

async function run(
	tool: ToolDefinition | undefined,
	params: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown> }> {
	assert.ok(tool);
	const result = (await tool.execute("call-1", params, undefined, undefined, undefined as never)) as {
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	};
	return { text: result.content[0]?.text ?? "", details: result.details ?? {} };
}

test("server stamp: a forged client oid is discarded and the real HEAD is stored", async (t) => {
	t.after(() => resetHeadCacheForTest());
	resetHeadCacheForTest();
	const head = samanthaHead();
	const repo = tempRoot(t);
	const projectRoot = join(repo, "packages", "design-lab");
	mkdirSync(projectRoot, { recursive: true });
	const mw = attach(projectRoot);
	const res = await post(
		mw,
		"/notes/event",
		{
			t: "note",
			id: "n_aaaaaaaaaaaa",
			at: AT,
			author: "samantha",
			screenId: "playground",
			x: 10,
			y: 20,
			text: "too tight",
			oid: FORGED_OID,
		},
		{ "x-lab-canvas": "1" },
	);
	assert.equal(res.status, 200);
	const event = JSON.parse(readFileSync(pluginFeedPath(projectRoot), "utf8").trim()) as Record<string, unknown>;
	assert.equal(event.author, "fei");
	assert.notEqual(event.oid, FORGED_OID);
	assert.equal(event.oid, head);
});

test("note.move is not speech, so it has no oid field", (t) => {
	t.after(() => resetHeadCacheForTest());
	let calls = 0;
	resetHeadCacheForTest({
		read: () => {
			calls += 1;
			return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		},
	});
	const root = tempRoot(t);
	appendEvent(note("n1"), root);
	appendEvent({ t: "note.move", id: "n1", at: AT, author: "fei", screenId: "mosaic", x: 900, y: 40 }, root);
	const move = parseFeed(readFileSync(feedPath(root), "utf8")).find((e) => e.t === "note.move");
	assert.ok(move);
	assert.equal("oid" in move, false);
	assert.equal(calls, 1, "a move must not ask git for a HEAD to stamp");
});

test("when git cannot be reached the event is still written, without oid, and nothing throws", (t) => {
	t.after(() => resetHeadCacheForTest());
	resetHeadCacheForTest({
		read: () => {
			throw new Error("git is not here");
		},
	});
	const root = tempRoot(t);
	assert.doesNotThrow(() => appendEvent(note("n1", { oid: FORGED_OID }), root));
	const event = lastLine(root);
	assert.equal(event.t, "note");
	assert.equal(event.id, "n1");
	assert.equal("oid" in event, false);
});

test("two events inside the 2s window ask HEAD once; after the window they ask again", (t) => {
	t.after(() => resetHeadCacheForTest());
	let calls = 0;
	let now = 0;
	resetHeadCacheForTest({
		read: () => {
			calls += 1;
			return `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${calls}`;
		},
		now: () => now,
	});
	const root = tempRoot(t);
	appendEvent(note("n1"), root);
	appendEvent({ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now" }, root);
	assert.equal(calls, 1);
	assert.equal(lastLine(root).oid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1");

	now = 2000;
	appendEvent({ t: "note.edit", id: "n1", at: AT, author: "fei", text: "still too tight" }, root);
	assert.equal(calls, 2);
	assert.equal(lastLine(root).oid, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2");
});

test("Thread.oid is the opening note; lastOid moves on later speech and not on a move", () => {
	const opened = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const spoken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
	const [thread] = projectThreads([
		{ t: "note", id: "n1", at: AT, author: "fei", screenId: "s", x: 0, y: 0, text: "too tight", oid: opened },
		{ t: "note.move", id: "n1", at: AT, author: "fei", screenId: "s", x: 9, y: 9 },
		{ t: "reply", id: "r1", noteId: "n1", at: AT, author: "samantha", text: "24px now", oid: spoken },
	]);
	assert.equal(thread.oid, opened);
	assert.equal(thread.lastOid, spoken);
	assert.notEqual(thread.oid, thread.lastOid);
});

test("design_version_since says the commit is not in the repo, not that the note is missing", async (t) => {
	const { repo } = await initRepo(t, ["one"]);
	const missingOid = "0123456789abcdef0123456789abcdef01234567";
	const file = feedPath(repo);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		serializeEvent({
			t: "note",
			id: "n1",
			at: AT,
			author: "fei",
			screenId: "s",
			x: 0,
			y: 0,
			text: "too tight",
			oid: missingOid,
		}),
		"utf8",
	);

	const result = commitsSinceNote("n1", { repoRoot: repo });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /这个提交不在仓里/);
	assert.doesNotMatch(result.error ?? "", /没找到|找不到/);

	const tool = harness(repo).get("design_version_since");
	assert.ok(tool);
	assert.match(tool.description, /read-only|does not restore|does not checkout|will not restore/i);
	const ran = await run(tool, { noteId: "n1" });
	assert.match(ran.text, /这个提交不在仓里/);
	assert.doesNotMatch(ran.text, /没找到|找不到/);
});
