/**
 * G-404 — publish version archive + wake previous publisher.
 *
 * Run from repo root:
 *   node --import tsx --test packages/her/test/publish-versions.test.ts
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { herPublish, stopPublishServer } from "../src/her-core/her-publish.ts";
import { drainInbox } from "../src/her-core/messages.ts";
import {
	archiveExistingPublish,
	buildPublishWakeMessage,
	PUBLISH_VERSION_CAP,
	shortSha256,
} from "../src/her-core/publish-versions.ts";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function memoryRoot(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-g404-"));
	t.after(async () => {
		await stopPublishServer();
	});
	return root;
}

function publishCfg(port: number) {
	return {
		bind: "127.0.0.1" as const,
		port,
		inlineThresholdBytes: 524_288,
		maxAssetBytes: 5_000_000,
	};
}

async function writePage(root: string, marker: string): Promise<string> {
	const src = join(root, "page.html");
	await writeFile(src, `<h1>${marker}</h1>`, "utf8");
	return src;
}

async function readManifest(
	root: string,
	slug: string,
): Promise<{
	slug: string;
	versions: Array<{ n: number; at: string; label?: string; bytes: number; sha256: string; sessionId?: string }>;
}> {
	const text = await readFile(join(root, "published", "versions", slug, "index.json"), "utf8");
	return JSON.parse(text) as {
		slug: string;
		versions: Array<{ n: number; at: string; label?: string; bytes: number; sha256: string; sessionId?: string }>;
	};
}

test("PUBLISH_VERSION_CAP is 20", () => {
	assert.equal(PUBLISH_VERSION_CAP, 20);
});

test("shortSha256 is a 16-char hex prefix of sha256", () => {
	// sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
	assert.equal(shortSha256("abc"), "ba7816bf8f01cfea");
	assert.match(shortSha256("abc"), /^[0-9a-f]{16}$/);
});

test("wake origin uses hyphens not colons", () => {
	const msg = buildPublishWakeMessage({
		slug: "hello-page",
		archivedN: 1,
		label: "nightly",
		fromSessionId: "sess-two",
		toSessionId: "sess-one",
	});
	assert.equal(msg.origin, "publish-hello-page-v1");
	assert.equal(msg.origin.includes(":"), false);
	assert.equal(msg.urgent, true);
	assert.equal(msg.from, "sess-two");
	assert.equal(msg.to, "sess-one");
	assert.equal(
		msg.body,
		"[发布更新] hello-page 被覆盖为 v2(标签:nightly)。旧版留档:published/versions/hello-page/v1.html",
	);
});

test("wake body uses 无 when label is missing", () => {
	const msg = buildPublishWakeMessage({
		slug: "hello-page",
		archivedN: 3,
		fromSessionId: "a",
		toSessionId: "b",
	});
	assert.equal(msg.body, "[发布更新] hello-page 被覆盖为 v4(标签:无)。旧版留档:published/versions/hello-page/v3.html");
	assert.equal(msg.origin, "publish-hello-page-v3");
	assert.equal(msg.origin.includes(":"), false);
});

test("first publish does not archive a version", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "first-edition");
	const result = await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19201),
	});
	assert.equal(result.slug, "hello-page");
	assert.equal(result.path, "published/hello-page.html");
	assert.equal(await exists(join(root, "published", "hello-page.html")), true);
	assert.equal(await exists(join(root, "published", "versions", "hello-page", "v1.html")), false);
	const manifestPath = join(root, "published", "versions", "hello-page", "index.json");
	if (await exists(manifestPath)) {
		const man = await readManifest(root, "hello-page");
		assert.equal(man.versions.length, 0);
	}
});

test("second publish archives v1 and writes a one-row manifest", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "first-edition");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		label: "launch",
		sessionId: "sess-one",
		publish: publishCfg(19202),
	});
	await writePage(root, "second-edition");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		label: "hotfix",
		sessionId: "sess-one",
		publish: publishCfg(19202),
	});
	const v1 = join(root, "published", "versions", "hello-page", "v1.html");
	assert.equal(await exists(v1), true);
	assert.match(await readFile(v1, "utf8"), /first-edition/);
	assert.match(await readFile(join(root, "published", "hello-page.html"), "utf8"), /second-edition/);
	const man = await readManifest(root, "hello-page");
	assert.equal(man.slug, "hello-page");
	assert.equal(man.versions.length, 1);
	const row = man.versions[0];
	assert.equal(row.n, 1);
	assert.equal(row.label, "launch");
	assert.equal(row.sessionId, "sess-one");
	assert.ok(Number.isFinite(Date.parse(row.at)));
	assert.match(row.sha256, /^[0-9a-f]{16}$/);
	assert.equal(row.bytes, Buffer.byteLength(await readFile(v1)));
});

test("third publish archives v2 and keeps version order", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "one");
	const input = {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19203),
	};
	await herPublish(root, input);
	await writePage(root, "two");
	await herPublish(root, input);
	await writePage(root, "three");
	await herPublish(root, input);
	const v1 = join(root, "published", "versions", "hello-page", "v1.html");
	const v2 = join(root, "published", "versions", "hello-page", "v2.html");
	assert.match(await readFile(v1, "utf8"), /one/);
	assert.match(await readFile(v2, "utf8"), /two/);
	assert.match(await readFile(join(root, "published", "hello-page.html"), "utf8"), /three/);
	const man = await readManifest(root, "hello-page");
	assert.deepEqual(
		man.versions.map((row) => row.n),
		[1, 2],
	);
});

test("label from the archived publish lands on that version row", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "labeled");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		label: "launch",
		sessionId: "sess-one",
		publish: publishCfg(19204),
	});
	await writePage(root, "next");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		label: "hotfix",
		sessionId: "sess-one",
		publish: publishCfg(19204),
	});
	const man = await readManifest(root, "hello-page");
	assert.equal(man.versions[0]?.label, "launch");
});

test("exceeding the cap deletes the oldest version file and manifest row", async () => {
	const root = await mkdtemp(join(tmpdir(), "her-g404-cap-"));
	const publishedRoot = join(root, "published");
	const live = join(publishedRoot, "demo.html");
	await mkdir(publishedRoot, { recursive: true });
	await writeFile(live, "one", "utf8");
	await archiveExistingPublish({ publishedRoot, slug: "demo", cap: 2 });
	await writeFile(live, "two", "utf8");
	await archiveExistingPublish({ publishedRoot, slug: "demo", cap: 2 });
	await writeFile(live, "three", "utf8");
	await archiveExistingPublish({ publishedRoot, slug: "demo", cap: 2 });
	assert.equal(await exists(join(publishedRoot, "versions", "demo", "v1.html")), false);
	assert.equal(await exists(join(publishedRoot, "versions", "demo", "v2.html")), true);
	assert.equal(await exists(join(publishedRoot, "versions", "demo", "v3.html")), true);
	assert.equal(await readFile(join(publishedRoot, "versions", "demo", "v2.html"), "utf8"), "two");
	assert.equal(await readFile(join(publishedRoot, "versions", "demo", "v3.html"), "utf8"), "three");
	const man = JSON.parse(await readFile(join(publishedRoot, "versions", "demo", "index.json"), "utf8")) as {
		versions: Array<{ n: number }>;
	};
	assert.deepEqual(
		man.versions.map((row) => row.n),
		[2, 3],
	);
});

test("same-session republish does not wake", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "a");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19205),
	});
	await writePage(root, "b");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19205),
	});
	const inbox = await drainInbox(root, "sess-one");
	assert.equal(inbox.length, 0);
});

test("cross-session republish wakes the previous publisher with a colon-free origin", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "a");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19206),
	});
	await writePage(root, "b");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		label: "nightly",
		sessionId: "sess-two",
		publish: publishCfg(19206),
	});
	const inbox = await drainInbox(root, "sess-one");
	assert.equal(inbox.length, 1);
	const msg = inbox[0];
	assert.equal(msg.from, "sess-two");
	assert.equal(msg.to, "sess-one");
	assert.equal(msg.urgent, true);
	assert.equal(msg.origin, "publish-hello-page-v1");
	assert.equal(msg.origin.includes(":"), false);
	assert.equal(
		msg.body,
		"[发布更新] hello-page 被覆盖为 v2(标签:nightly)。旧版留档:published/versions/hello-page/v1.html",
	);
});

test("wake failure does not change the publish return value", async (t) => {
	const root = await memoryRoot(t);
	const src = await writePage(root, "a");
	await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-one",
		publish: publishCfg(19207),
	});
	await writePage(root, "b");
	let called = false;
	const warn = mock.method(console, "warn", () => {});
	t.after(() => warn.mock.restore());
	const result = await herPublish(root, {
		filePath: src,
		title: "Hello Page",
		description: "test page",
		slug: "hello-page",
		sessionId: "sess-two",
		publish: publishCfg(19207),
		sendMessage: async () => {
			called = true;
			throw new Error("wake-fail");
		},
	});
	assert.equal(called, true);
	assert.equal(result.slug, "hello-page");
	assert.equal(result.path, "published/hello-page.html");
	assert.ok(result.bytes > 0);
	assert.match(result.url, /hello-page\.html/);
	assert.ok(warn.mock.calls.length >= 1);
});
