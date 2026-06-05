import assert from "node:assert/strict";
import type { lookup as dnsLookup } from "node:dns/promises";
import test from "node:test";
import { readUrlForWorldNote } from "../src/her-core/index.ts";

function responseJson(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function responseText(text: string): Response {
	return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof Request) return input.url;
	if (input instanceof URL) return input.href;
	return String(input);
}

test("URL intake deep reads selected GitHub repository files", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = inputUrl(input);
		if (url === "https://api.github.com/repos/next1foreal/her-sample") {
			return responseJson({
				default_branch: "main",
				description: "A small repository for Her repo intake verification.",
			});
		}
		if (url === "https://api.github.com/repos/next1foreal/her-sample/git/trees/main?recursive=1") {
			return responseJson({
				tree: [
					{ path: "README.md", size: 84, type: "blob" },
					{ path: "package.json", size: 44, type: "blob" },
					{ path: "src/index.ts", size: 160, type: "blob" },
					{ path: "dist/index.js", size: 120, type: "blob" },
				],
			});
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/README.md") {
			return responseText("# Her Sample\n\nThis repo demonstrates a durable memory intake path.");
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/package.json") {
			return responseText('{"name":"her-sample","type":"module"}');
		}
		if (url === "https://raw.githubusercontent.com/next1foreal/her-sample/main/src/index.ts") {
			return responseText("export function runSamanthaMemory() {\n\treturn 'durable';\n}\n");
		}
		throw new Error(`unexpected fetch: ${url}`);
	};
	const lookup = (async () => [{ address: "140.82.112.4", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://github.com/next1foreal/her-sample", {
		fetcher,
		lookup,
		maxRepoFiles: 3,
	});

	assert.equal(result.data.sourceType, "repo");
	assert.equal(result.data.sourceUrl, "https://github.com/next1foreal/her-sample");
	assert.equal(result.data.title, "next1foreal/her-sample repository");
	assert.equal(result.data.memoryStatus, "active");
	assert.match(result.data.coverage, /Read 3 repository files/);
	assert.match(result.data.coverage, /Files read: README\.md, package\.json, src\/index\.ts/);
	assert.match(result.data.coverage, /src\/index\.ts: runSamanthaMemory/);
	assert.match(result.data.extracted, /## README\.md/);
	assert.match(result.data.extracted, /## src\/index\.ts/);
	assert.match(result.data.extracted, /export function runSamanthaMemory/);
	assert.deepEqual(result.data.steal, ["src/index.ts: runSamanthaMemory"]);
	assert.equal(result.truncated, false);
	assert.ok(result.bytesRead > 0);
});

test("URL intake marks X threads as needs_deep_read without fetching login walls", async () => {
	const fetcher: typeof fetch = async () => {
		throw new Error("X thread intake should not fetch unauthenticated HTML");
	};
	const lookup = (async () => [{ address: "104.244.42.1", family: 4 }]) as unknown as typeof dnsLookup;

	const result = await readUrlForWorldNote("https://x.com/example/status/1234567890", { fetcher, lookup });

	assert.equal(result.data.sourceType, "x-thread");
	assert.equal(result.data.memoryStatus, "needs_deep_read");
	assert.match(result.data.memoryStatusReason ?? "", /browser-native or authenticated reading/);
	assert.match(result.data.coverage, /minimal URL intake did not fetch login-wall HTML/);
	assert.equal(result.bytesRead, 0);
	assert.equal(result.truncated, false);
});
