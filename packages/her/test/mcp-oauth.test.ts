import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HeadlessAuthRequired, HerOAuthProvider, oauthStorePath, startLoginCallback } from "../src/mcp/oauth.ts";
import { loadConnectors } from "../src/mcp/tools.ts";

const root = () => mkdtemp(join(tmpdir(), "her-oauth-"));

async function manifest(dir: string, connectors: unknown[]): Promise<void> {
	await mkdir(join(dir, ".her"), { recursive: true });
	await writeFile(join(dir, ".her", "connectors.json"), JSON.stringify({ version: 1, connectors }), "utf8");
}

test('an "auth": "oauth" connector is ready with no header and nothing to paste', async () => {
	const dir = await root();
	await manifest(dir, [
		{ slug: "hosted", label: "Hosted", type: "http", url: "https://example.com/mcp", auth: "oauth" },
	]);

	const loaded = await loadConnectors(dir, {});
	assert.equal(loaded.kind, "loaded");
	if (loaded.kind !== "loaded") return;
	const connector = loaded.connectors[0];
	assert.equal(connector.status, "ready", "a browser-login connector needs no environment variable");
	if (connector.status !== "ready" || connector.transport !== "http") return;
	assert.equal(connector.auth, "oauth");
	assert.deepEqual(connector.headers, {});
	assert.deepEqual(connector.secrets, []);
	// The client has to know which manifest it came from to find the grant.
	assert.equal(connector.repoRoot, dir);
});

test("a scheduled run REFUSES to open a browser, and says what to run instead", async () => {
	// The whole point. A hidden task cannot show anyone a login page; trying
	// is how the gateway sat on an unanswerable prompt for hours.
	const dir = await root();
	const headless = new HerOAuthProvider(dir, "hosted", "Hosted");
	assert.equal(headless.redirectUrl, undefined, "no redirect target means no interactive flow");
	assert.throws(
		() => headless.redirectToAuthorization(new URL("https://example.com/authorize")),
		(error: unknown) => {
			assert.ok(error instanceof HeadlessAuthRequired);
			assert.match((error as Error).message, /her_mcp_login/);
			assert.match((error as Error).message, /hosted/);
			return true;
		},
	);

	// And with a person present it hands the URL over instead of throwing.
	let seen: URL | null = null;
	const interactive = new HerOAuthProvider(dir, "hosted", "Hosted", {
		redirectUrl: "http://127.0.0.1:1234/callback",
		onAuthorizationUrl: (url) => {
			seen = url;
		},
	});
	interactive.redirectToAuthorization(new URL("https://example.com/authorize?x=1"));
	assert.equal(String(seen), "https://example.com/authorize?x=1");
	assert.equal(interactive.redirectUrl, "http://127.0.0.1:1234/callback");
});

test("the grant round-trips to its own file, and clearing it removes the file", async () => {
	const dir = await root();
	const provider = new HerOAuthProvider(dir, "hosted", "Hosted");
	assert.equal(await provider.tokens(), undefined);

	await provider.saveClientInformation({ client_id: "abc" } as never);
	await provider.saveTokens({ access_token: "tok-123", token_type: "Bearer" } as never);
	await provider.saveCodeVerifier("verifier-xyz");

	const path = oauthStorePath(dir, "hosted");
	const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	assert.equal((onDisk.tokens as { access_token: string }).access_token, "tok-123");
	assert.equal(await provider.codeVerifier(), "verifier-xyz");

	// A fresh reader sees the same grant — the flow spans processes.
	assert.equal((await new HerOAuthProvider(dir, "hosted", "Hosted").tokens())?.access_token, "tok-123");

	await provider.invalidateCredentials("all");
	assert.equal(await provider.tokens(), undefined);
});

test("the login callback really catches the redirect, on loopback only", async () => {
	const callback = await startLoginCallback(10_000);
	try {
		assert.match(
			callback.redirectUrl,
			/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
			"the grant must not leave this machine",
		);
		const res = await fetch(`${callback.redirectUrl}?code=the-code&state=s`);
		assert.equal(res.status, 200);
		assert.match(await res.text(), /授权完成/);
		assert.equal(await callback.waitForCode, "the-code");
	} finally {
		callback.close();
	}
});

test("a denied authorization surfaces the reason rather than hanging", async () => {
	const callback = await startLoginCallback(10_000);
	try {
		await fetch(`${callback.redirectUrl}?error=access_denied`);
		await assert.rejects(callback.waitForCode, /access_denied/);
	} finally {
		callback.close();
	}
});
