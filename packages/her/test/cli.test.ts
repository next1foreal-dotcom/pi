import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initStore, Memory, parseFrontmatter, readText } from "../src/her-core/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function git(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync("git", args, { cwd });
	return { stdout, stderr };
}

async function gitBackedStore(): Promise<{ store: string; remote: string }> {
	const store = await mkdtemp(join(tmpdir(), "her-cli-"));
	const remote = await mkdtemp(join(tmpdir(), "her-cli-remote-"));
	await initStore(store);
	await git(remote, "init", "--bare");
	await git(store, "init");
	await git(store, "config", "user.name", "Her CLI Test");
	await git(store, "config", "user.email", "her-cli-test@example.com");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: init");
	await git(store, "branch", "-M", "master");
	await git(store, "remote", "add", "origin", remote);
	await git(store, "push", "-u", "origin", "master");
	return { store, remote };
}

async function runCli(
	args: string[],
	store: string,
	envOverrides: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		["--import", "tsx", "packages/her/src/cli.ts", ...args],
		{
			cwd: repoRoot,
			env: { ...process.env, HER_MEMORY_DIR: store, ...envOverrides },
		},
	);
	return { stdout, stderr };
}

async function runCliFailure(
	args: string[],
	store: string,
	envOverrides: Record<string, string> = {},
): Promise<{ code?: number; stdout: string; stderr: string }> {
	try {
		await runCli(args, store, envOverrides);
		assert.fail("CLI command unexpectedly succeeded");
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
	}
}

async function withLocalChatModel<T>(
	reply: (prompt: string) => string,
	fn: (env: Record<string, string>, prompts: string[]) => Promise<T>,
): Promise<T> {
	const prompts: string[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
			const prompt = String(parsed.messages?.[0]?.content ?? "");
			prompts.push(prompt);
			let content: string;
			try {
				content = reply(prompt);
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ choices: [{ message: { content } }] }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address() as AddressInfo;
	try {
		return await fn(
			{
				HER_SUMMARY_BASE_URL: `http://127.0.0.1:${port}`,
				HER_SUMMARY_MODEL: "her-cli-test-model",
			},
			prompts,
		);
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
}

async function withLocalSource<T>(
	response: { body: string; contentType?: string; path?: string },
	fn: (url: string) => Promise<T>,
): Promise<T> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": response.contentType ?? "text/html; charset=utf-8" });
		res.end(response.body);
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address() as AddressInfo;
	try {
		return await fn(`http://127.0.0.1:${port}${response.path ?? "/source"}`);
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
}

async function withLocalTelegramApi<T>(
	fn: (env: Record<string, string>, requests: Array<{ body: Record<string, unknown>; url: string }>) => Promise<T>,
	updates: unknown[] = [
		{
			update_id: 7001,
			message: { message_id: 1, chat: { id: 42 }, text: "Her 状态", from: { id: 42 } },
		},
	],
): Promise<T> {
	const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
			const url = req.url ?? "";
			requests.push({ body: parsed, url });
			res.writeHead(200, { "content-type": "application/json" });
			if (url.endsWith("/getUpdates")) {
				res.end(
					JSON.stringify({
						ok: true,
						result: updates,
					}),
				);
				return;
			}
			if (url.endsWith("/sendMessage")) {
				res.end(JSON.stringify({ ok: true, result: { message_id: 7002, chat: { id: 42 }, text: parsed.text } }));
				return;
			}
			res.end(JSON.stringify({ ok: false, description: `unexpected path ${url}` }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address() as AddressInfo;
	try {
		return await fn(
			{
				HER_TELEGRAM_BASE_URL: `http://127.0.0.1:${port}`,
				HER_TELEGRAM_BOT_TOKEN: "test-token",
				HER_TELEGRAM_CHAT_ID: "42",
			},
			requests,
		);
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
}

async function withLocalPiResponderShim<T>(reply: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const bin = await mkdtemp(join(tmpdir(), "her-pi-reply-bin-"));
	const shim = join(bin, "pi-reply-shim.mjs");
	await writeFile(
		shim,
		[
			`const prompt = process.argv.at(-1) ?? "";`,
			`if (!process.argv.includes("openai-codex")) throw new Error("missing default OAuth provider");`,
			`if (!process.argv.includes("gpt-5.4-mini:low")) throw new Error("missing default Telegram model");`,
			`if (!prompt.includes("Her 状态")) throw new Error("missing Telegram prompt text");`,
			`if (!prompt.includes("只允许使用这些 Her tools")) throw new Error("missing safety boundary");`,
			`console.log(${JSON.stringify(reply)});`,
			"",
		].join("\n"),
		"utf8",
	);
	return fn({ HER_TELEGRAM_PI_CLI: shim });
}

async function withCurlMdShim<T>(markdown: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const bin = await mkdtemp(join(tmpdir(), "her-curl-md-bin-"));
	const shim = join(bin, "curl-md-shim.mjs");
	await writeFile(shim, `console.log(${JSON.stringify(markdown)});\n`, "utf8");
	const shellShim = join(bin, "curl.md");
	await writeFile(shellShim, `#!/usr/bin/env sh\n"${process.execPath}" "${shim}" "$@"\n`, "utf8");
	await chmod(shellShim, 0o755);
	const cmdShim = join(bin, "curl.md.cmd");
	await writeFile(cmdShim, `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`, "utf8");
	const pathValue = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
	return fn({
		HER_CURL_MD_BIN: process.platform === "win32" ? cmdShim : shellShim,
		Path: pathValue,
		PATH: pathValue,
	});
}

async function withDefuddleShim<T>(markdown: string, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const bin = await mkdtemp(join(tmpdir(), "her-defuddle-bin-"));
	const shim = join(bin, "defuddle-shim.mjs");
	await writeFile(shim, `console.log(${JSON.stringify(markdown)});\n`, "utf8");
	const shellShim = join(bin, "defuddle");
	await writeFile(shellShim, `#!/usr/bin/env sh\n"${process.execPath}" "${shim}" "$@"\n`, "utf8");
	await chmod(shellShim, 0o755);
	const cmdShim = join(bin, "defuddle.cmd");
	await writeFile(cmdShim, `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`, "utf8");
	const pathValue = `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`;
	return fn({
		HER_CURL_MD_ENABLED: "0",
		HER_DEFUDDLE_BIN: process.platform === "win32" ? cmdShim : shellShim,
		Path: pathValue,
		PATH: pathValue,
	});
}

test("CLI intake-url prefers curl.md optimized markdown for public pages", async () => {
	const { store } = await gitBackedStore();

	await withCurlMdShim("# Curl MD Fixture\n\nOptimized markdown from curl.md enters Her memory.", async (env) => {
		const result = await runCli(["intake-url", "--url", "https://example.com/curl-md-fixture", "--json"], store, env);
		const payload = JSON.parse(result.stdout);

		assert.equal(payload.result.sourceType, "article");
		assert.equal(payload.result.memoryStatus, "active");
		assert.equal(payload.result.truncated, false);
		assert.ok(payload.result.bytesRead > 0);

		const world = await readFile(join(store, "world", "curl-md-fixture.md"), "utf8");
		assert.match(world, /Optimized markdown from curl\.md enters Her memory/);
		assert.match(world, /Read curl\.md optimized markdown/);
	});
});

test("CLI intake-url can read X URLs through defuddle when curl.md is disabled", async () => {
	const { store } = await gitBackedStore();

	await withDefuddleShim("# X Thread Fixture\n\nPublic X content extracted through Defuddle.", async (env) => {
		const result = await runCli(
			["intake-url", "--url", "https://x.com/example/status/1234567890", "--json"],
			store,
			env,
		);
		const payload = JSON.parse(result.stdout);

		assert.equal(payload.result.sourceType, "x-thread");
		assert.equal(payload.result.memoryStatus, "active");
		assert.equal(payload.result.truncated, false);
		assert.ok(payload.result.bytesRead > 0);

		const world = await readFile(join(store, "world", "x-thread-fixture.md"), "utf8");
		assert.match(world, /Public X content extracted through Defuddle/);
		assert.match(world, /defuddle optimized markdown/);
	});
});

test("CLI Telegram poll and outbox commands use env credentials against the Bot API", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, "outbox", "2026-06-13-heartbeat.md"), "# Heartbeat\n\nHer is awake.", "utf8");

	await withLocalTelegramApi(async (env, requests) => {
		let result = await runCli(["telegram-poll", "--timeout", "0", "--limit", "10", "--json"], store, env);
		let payload = JSON.parse(result.stdout);
		assert.equal(payload.result.received, 1);
		assert.equal(payload.result.queued.length, 1);
		assert.equal(payload.result.nextOffset, 7002);
		assert.match(
			await readFile(join(store, "tasks", "inbox", payload.result.queued[0].path.split("/").pop()), "utf8"),
			/Her 状态/,
		);

		result = await runCli(["telegram-push-outbox", "--limit", "1", "--json"], store, env);
		payload = JSON.parse(result.stdout);
		assert.equal(payload.result.sent.length, 1);
		assert.equal(payload.result.sent[0].messageId, 7002);

		assert.equal(requests[0].url, "/bottest-token/getUpdates");
		assert.deepEqual(requests[0].body.allowed_updates, ["message"]);
		assert.equal(requests[1].url, "/bottest-token/sendMessage");
		assert.equal(requests[1].body.chat_id, "42");
		assert.match(String(requests[1].body.text), /# Heartbeat/);
	});
});

test("CLI Telegram bridge polls inbound messages and acknowledges queued items", async () => {
	const { store } = await gitBackedStore();

	await withLocalTelegramApi(async (env, requests) => {
		const result = await runCli(
			["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--json"],
			store,
			env,
		);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.result.poll.received, 1);
		assert.equal(payload.result.poll.queued.length, 1);
		assert.equal(payload.result.acknowledgements.length, 1);
		assert.equal(payload.result.outbox.sent.length, 0);

		assert.equal(requests[0].url, "/bottest-token/getUpdates");
		assert.equal(requests[1].url, "/bottest-token/sendMessage");
		assert.equal(requests[1].body.chat_id, "42");
		assert.match(String(requests[1].body.text), /已进入 Her inbox/);
		assert.match(String(requests[1].body.text), /不会被自动执行/);
	});
});

test("CLI Telegram bridge ignores duplicate Telegram update ids", async () => {
	const { store } = await gitBackedStore();

	await withLocalTelegramApi(async (env, requests) => {
		let result = await runCli(["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--json"], store, env);
		let payload = JSON.parse(result.stdout);
		assert.equal(payload.result.poll.queued.length, 1);
		assert.equal(payload.result.acknowledgements.length, 1);

		result = await runCli(["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--json"], store, env);
		payload = JSON.parse(result.stdout);
		assert.equal(payload.result.poll.queued.length, 0);
		assert.equal(payload.result.poll.ignored.length, 1);
		assert.equal(payload.result.poll.ignored[0].reason, "duplicate update");
		assert.equal(payload.result.acknowledgements.length, 0);
		assert.equal(requests.filter((request) => request.url.endsWith("/sendMessage")).length, 1);
	});
});

test("CLI Telegram bridge can answer inbound messages through the safe Pi responder", async () => {
	const { store } = await gitBackedStore();

	await withLocalTelegramApi(async (telegramEnv, requests) => {
		await withLocalPiResponderShim("Her 完整回复：我会先看记忆，再给你结论。", async (piEnv) => {
			const result = await runCli(
				["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--reply-mode", "pi", "--json"],
				store,
				{ ...telegramEnv, ...piEnv },
			);
			const payload = JSON.parse(result.stdout);
			assert.equal(payload.result.poll.received, 1);
			assert.equal(payload.result.poll.queued.length, 1);
			assert.equal(payload.result.acknowledgements.length, 0);
			assert.equal(payload.result.replies.length, 1);
			assert.equal(payload.result.outbox.sent.length, 0);

			assert.equal(requests[0].url, "/bottest-token/getUpdates");
			assert.equal(requests[1].url, "/bottest-token/sendMessage");
			assert.equal(requests[1].body.chat_id, "42");
			assert.match(String(requests[1].body.text), /Her 完整回复/);
		});
	});
});

test("CLI Telegram Pi responder rejects non-read-only tools from env", async () => {
	const { store } = await gitBackedStore();

	await withLocalTelegramApi(async (telegramEnv, requests) => {
		await withLocalPiResponderShim("this should not run", async (piEnv) => {
			const result = await runCliFailure(
				["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--reply-mode", "pi", "--json"],
				store,
				{ ...telegramEnv, ...piEnv, HER_TELEGRAM_PI_TOOLS: "her_status,her_task_create" },
			);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /read-only Telegram responder tools/);
			assert.match(result.stderr, /her_task_create/);
			assert.equal(requests.filter((request) => request.url.endsWith("/sendMessage")).length, 0);
		});
	});
});

test("CLI Telegram confirmation request queues a phone approval without executing it", async () => {
	const { store } = await gitBackedStore();

	const result = await runCli(
		[
			"telegram-confirm-request",
			"--action-id",
			"tier2-test",
			"--summary",
			"Run a single Tier 2 smoke action",
			"--code",
			"SAFE42",
			"--expires-at",
			"2026-06-20T12:15:00.000Z",
			"--json",
		],
		store,
	);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.actionId, "tier2-test");
	assert.equal(payload.result.code, "SAFE42");
	assert.equal(payload.result.status, "pending");

	const confirmation = await readFile(join(store, payload.result.path), "utf8");
	assert.match(confirmation, /status: pending/);
	assert.match(confirmation, /Run a single Tier 2 smoke action/);
	assert.match(confirmation, /Telegram can approve or reject this request, but it must not execute/);

	const outboxFiles = await readdir(join(store, "outbox"));
	assert.equal(outboxFiles.length, 1);
	const outbox = await readFile(join(store, "outbox", outboxFiles[0]), "utf8");
	assert.match(outbox, /CONFIRM SAFE42/);
	assert.match(outbox, /Telegram 只记录批准\/拒绝，不会直接执行动作/);
});

test("CLI Telegram bridge records confirmation replies and does not invoke the Pi responder", async () => {
	const { store } = await gitBackedStore();
	await runCli(
		[
			"telegram-confirm-request",
			"--action-id",
			"tier2-test",
			"--summary",
			"Run a single Tier 2 smoke action",
			"--code",
			"SAFE42",
			"--expires-at",
			"2999-06-20T12:15:00.000Z",
			"--json",
		],
		store,
	);
	await withLocalTelegramApi(async (telegramEnv) => {
		await runCli(["telegram-push-outbox", "--limit", "1", "--json"], store, telegramEnv);
	}, []);

	await withLocalTelegramApi(
		async (telegramEnv, requests) => {
			const result = await runCli(
				["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--reply-mode", "pi", "--json"],
				store,
				{ ...telegramEnv, HER_TELEGRAM_PI_CLI: "missing-pi-shim.mjs" },
			);
			const payload = JSON.parse(result.stdout);
			assert.equal(payload.result.confirmations.length, 1);
			assert.equal(payload.result.confirmations[0].status, "approved");
			assert.equal(payload.result.replies.length, 0);
			assert.equal(payload.result.acknowledgements.length, 1);

			const confirmationPath = payload.result.confirmations[0].path;
			const confirmation = await readFile(join(store, confirmationPath), "utf8");
			assert.match(confirmation, /status: approved/);
			assert.match(confirmation, /reply: CONFIRM SAFE42/);

			assert.equal(requests.filter((request) => request.url.endsWith("/sendMessage")).length, 1);
			assert.match(String(requests[1].body.text), /已记录确认/);
			assert.match(String(requests[1].body.text), /不会直接执行动作/);
		},
		[
			{
				update_id: 7001,
				message: { message_id: 1, chat: { id: 42 }, text: "CONFIRM SAFE42", from: { id: 42 } },
			},
		],
	);
});

test("CLI Telegram bridge refuses expired confirmation codes", async () => {
	const { store } = await gitBackedStore();
	await runCli(
		[
			"telegram-confirm-request",
			"--action-id",
			"expired-tier2-test",
			"--summary",
			"Expired action",
			"--code",
			"OLD42",
			"--expires-at",
			"2000-01-01T00:00:00.000Z",
			"--json",
		],
		store,
	);
	await withLocalTelegramApi(async (telegramEnv) => {
		await runCli(["telegram-push-outbox", "--limit", "1", "--json"], store, telegramEnv);
	}, []);

	await withLocalTelegramApi(
		async (telegramEnv, requests) => {
			const result = await runCli(
				["telegram-bridge", "--once", "--timeout", "0", "--limit", "10", "--json"],
				store,
				telegramEnv,
			);
			const payload = JSON.parse(result.stdout);
			assert.equal(payload.result.confirmations.length, 1);
			assert.equal(payload.result.confirmations[0].status, "ignored");
			assert.match(payload.result.confirmations[0].reason, /expired/);

			const confirmationPath = payload.result.confirmations[0].path;
			const confirmation = await readFile(join(store, confirmationPath), "utf8");
			assert.match(confirmation, /status: expired/);
			assert.equal(requests.filter((request) => request.url.endsWith("/sendMessage")).length, 1);
			assert.match(String(requests[1].body.text), /确认没有生效/);
		},
		[
			{
				update_id: 7001,
				message: { message_id: 1, chat: { id: 42 }, text: "CONFIRM OLD42", from: { id: 42 } },
			},
		],
	);
});

async function withLocalEmbeddings<T>(fn: (env: Record<string, string>, inputs: string[][]) => Promise<T>): Promise<T> {
	const inputs: string[][] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body) as { input?: string[] };
			const requestInputs = parsed.input ?? [];
			inputs.push(requestInputs);
			const data = requestInputs.map((text) => ({
				embedding: text.includes("latent") || text.includes("unspoken") ? [1, 0] : [0, 1],
			}));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const { port } = server.address() as AddressInfo;
	try {
		return await fn(
			{
				HER_EMBEDDINGS_BASE_URL: `http://127.0.0.1:${port}/v1`,
				HER_EMBEDDINGS_MODEL: "her-test-embeddings",
			},
			inputs,
		);
	} finally {
		await new Promise<void>((resolveClose, reject) =>
			server.close((error) => (error ? reject(error) : resolveClose())),
		);
	}
}

test("CLI reports Her memory sync status as JSON", async () => {
	const { store } = await gitBackedStore();

	let result = await runCli(["sync", "--status", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.memoryDir, store);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal(payload.status.branch, "master");
	assert.match(payload.lastSyncedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(payload.status.lastSyncedAt, payload.lastSyncedAt);

	await new Memory(store).remember("Pending local memory for the CLI.", "note");
	result = await runCli(["sync", "--status", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.status.status, "unsynced");
	assert.equal(payload.status.dirtyFiles, 1);
	assert.equal(payload.status.pending, 1);
	assert.equal(payload.status.lastSyncedAt, payload.lastSyncedAt);
});

test("CLI sync commits and pushes dirty Her memory", async () => {
	const { store, remote } = await gitBackedStore();
	await new Memory(store).remember("CLI should commit and push this memory.", "note");

	const result = await runCli(["sync", "--message", "memory(sync): cli test", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.status, "pushed");
	assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
	assert.equal(payload.status.status, "synced");
	assert.equal(payload.status.pending, 0);
	assert.equal((await git(store, "status", "--porcelain")).stdout.trim(), "");
	assert.match((await git(remote, "log", "--oneline", "-1")).stdout, /memory\(sync\): cli test/);
});

test("CLI captures a UI message through TS her-core as JSON", async () => {
	const { store } = await gitBackedStore();
	const secret = `sk-${"123456789012345678901234"}`;
	const text = `Samantha UI should capture this safely. ${secret}`;

	await withLocalChatModel(
		(prompt) => {
			assert.doesNotMatch(prompt, new RegExp(secret));
			assert.match(prompt, /«REDACTED:secret»/);
			return "- captured safely from UI";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(
				[
					"capture",
					"--text",
					text,
					"--project",
					"samantha-ui",
					"--session",
					"gui-test",
					"--timestamp",
					"2026-06-05T1200",
					"--json",
				],
				store,
				modelEnv,
			);
			const payload = JSON.parse(result.stdout);

			assert.equal(payload.result.id, "gui-test");
			assert.equal(payload.status.status, "unsynced");
			assert.equal(prompts.length, 1);
			const raw = await readFile(join(store, "episodic", "raw", "2026-06-05T1200--gui-test.md"), "utf8");
			assert.match(raw, /samantha-ui/);
			assert.doesNotMatch(raw, new RegExp(secret));
			assert.match(raw, /«REDACTED:secret»/);
			assert.match(await readFile(join(store, "episodic", "2026-06-05.md"), "utf8"), /captured safely from UI/);
		},
	);
});

test("CLI writes a protected weekly Samantha journal entry", async () => {
	const { store } = await gitBackedStore();

	const result = await runCli(
		[
			"journal",
			"--kind",
			"weekly",
			"--title",
			"Weekly Test",
			"--timestamp",
			"2026-06-13T01:02:03.000Z",
			"--run",
			"outbox/test-heartbeat.md",
			"--text",
			"## 我最近反复想要什么\n继续保留不被任务吞掉的部分。",
			"--json",
		],
		store,
	);
	const payload = JSON.parse(result.stdout) as { result: { kind: string; path: string }; status: { status: string } };

	assert.equal(payload.result.kind, "weekly");
	assert.match(payload.result.path, /^samantha\/journal\/weekly\/2026-06-13--weekly-test--[a-f0-9]{8}\.md$/);
	assert.equal(payload.status.status, "unsynced");
	const parsed = parseFrontmatter(await readText(join(store, payload.result.path)));
	assert.equal(parsed.data.protected_zone, true);
	assert.equal(parsed.data.provenance, "her-direct");
	assert.equal(parsed.data.consolidate, false);
	assert.equal(parsed.data.evaluate, false);
	assert.equal(parsed.data.roi, false);
	assert.equal(parsed.data.auto_promote, false);
	assert.equal(parsed.data.heartbeat_run, "outbox/test-heartbeat.md");
	assert.match(parsed.body, /我最近反复想要什么/);
});

test("CLI writes a protected Samantha taste judgment", async () => {
	const { store } = await gitBackedStore();

	const result = await runCli(
		[
			"taste",
			"--title",
			"Room Over Dashboard",
			"--judgment",
			"Prefer a room-like interface before metrics panels.",
			"--reason",
			"The room preserves memory, pause, and return.",
			"--differs-from-fei-rule",
			"Fei may reach for dashboards when anxious.",
			"--timestamp",
			"2026-06-14T01:02:03.000Z",
			"--json",
		],
		store,
	);
	const payload = JSON.parse(result.stdout) as { result: { path: string }; status: { status: string } };

	assert.match(payload.result.path, /^samantha\/taste\/2026-06-14--room-over-dashboard--[a-f0-9]{8}\.md$/);
	assert.equal(payload.status.status, "unsynced");
	const parsed = parseFrontmatter(await readText(join(store, payload.result.path)));
	assert.equal(parsed.data.category, "taste");
	assert.equal(parsed.data.protected_zone, true);
	assert.equal(parsed.data.provenance, "her-direct");
	assert.equal(parsed.data.consolidate, false);
	assert.equal(parsed.data.evaluate, false);
	assert.equal(parsed.data.roi, false);
	assert.equal(parsed.data.auto_promote, false);
	assert.equal(parsed.data.differs_from_fei_rule, true);
	assert.match(parsed.body, /Room Over Dashboard/);
});

test("CLI audits privacy classification and blocks unsafe export refs", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, "episodic", "raw", "legacy.md"), "# Legacy\n\n朋友说这件事不要外传。\n", "utf8");
	await writeFile(
		join(store, "world", "public-source.md"),
		[
			"---",
			"id: world-public",
			"source_url: https://example.com/source",
			"privacy: public",
			"provenance: world-ingested",
			"---",
			"# Public Source",
		].join("\n"),
		"utf8",
	);

	let result = await runCli(["privacy-audit", "--json"], store);
	const auditPayload = JSON.parse(result.stdout) as { result: { inferred: number; records: Array<{ path: string }> } };
	assert.ok(auditPayload.result.inferred > 0);
	assert.ok(auditPayload.result.records.some((record) => record.path === "episodic/raw/legacy.md"));

	result = await runCli(["privacy-check", "--ref", "world/public-source.md", "--json"], store);
	const checkPayload = JSON.parse(result.stdout) as { result: { allowed: boolean } };
	assert.equal(checkPayload.result.allowed, true);

	try {
		await runCli(["privacy-check", "--ref", "episodic/raw/legacy.md", "--json"], store);
		assert.fail("privacy-check should exit non-zero for private or intimate refs");
	} catch (error) {
		const failure = error as { stdout?: string };
		const blocked = JSON.parse(failure.stdout ?? "{}") as { result?: { allowed?: boolean; blocked?: unknown[] } };
		assert.equal(blocked.result?.allowed, false);
		assert.equal(blocked.result?.blocked?.length, 1);
	}
});

test("CLI persists an intake source with recall verification as JSON", async () => {
	const { store } = await gitBackedStore();

	const result = await runCli(
		[
			"intake-source",
			"--title",
			"Agent Intake Patterns",
			"--source-url",
			"https://example.com/intake",
			"--source-type",
			"article",
			"--extracted",
			"A complete short article about source intake and recall verification.",
			"--coverage",
			"Read full short article; no sections skipped.",
			"--claim-json",
			JSON.stringify({
				claim: "Trusted writer computes content hashes.",
				verdict: "supported",
				evidence: "The fixture source describes trusted writer hash computation.",
				sourceQuality: "primary",
				caveats: "Synthetic fixture.",
			}),
			"--read",
			"The useful pattern is letting the trusted writer compute content hashes.",
			"--steal",
			"Compute content hashes in the trusted write tool",
			"--connection",
			"mirror",
			"--take",
			"This tightens the Stage 2 intake chain.",
			"--possible-move",
			"Use her intake-source from RPC shells.",
			"--memory-status",
			"needs_deep_read",
			"--memory-status-reason",
			"Fixture source is useful but still needs a deeper second pass.",
			"--json",
		],
		store,
	);
	const payload = JSON.parse(result.stdout);

	assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
	assert.match(payload.result.contentHash, /^[0-9a-f]{64}$/);
	assert.ok(payload.result.recall.some((note: { id: string }) => note.id === "world/agent-intake-patterns"));
	assert.equal(payload.status.status, "unsynced");

	const world = await readFile(join(store, "world", "agent-intake-patterns.md"), "utf8");
	assert.match(world, /memory_status: needs_deep_read/);
	assert.match(world, /memory_status_reason: Fixture source is useful but still needs a deeper second pass\./);
	assert.match(world, /reason: Fixture source is useful but still needs a deeper second pass\./);
	assert.match(world, /claim_count: 1/);
	assert.match(world, /claim: Trusted writer computes content hashes/);
	assert.match(world, /verdict: supported/);
	assert.match(world, /recall verification/);
	assert.match(world, /\[\[mirror\]\]/);
	const seen = JSON.parse(await readFile(join(store, ".her", "seen.json"), "utf8"));
	assert.equal(seen[payload.result.contentHash], payload.result.noteId);
});

test("CLI intake-source can update related topics and ideas immediately", async () => {
	const { store } = await gitBackedStore();

	await withLocalChatModel(
		(prompt) => {
			if (prompt.includes("Group these knowledge units")) {
				assert.match(prompt, /agent-intake-patterns/);
				return JSON.stringify({
					maps: [
						{
							theme: "Intake Practice",
							summary: "Trusted source intake with recall verification.",
							members: ["agent-intake-patterns"],
						},
					],
				});
			}
			if (prompt.includes("Idea Engine")) {
				assert.match(prompt, /Intake Practice/);
				return JSON.stringify({
					ideas: [
						{
							title: "Intake as graph ignition",
							connects: ["agent-intake-patterns"],
							insight: "A source should update live connection surfaces when it enters memory.",
							spark: "Use intake as the trigger for local topic and idea refreshes.",
							kind: "world-x-system",
						},
					],
				});
			}
			throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
		},
		async (modelEnv, prompts) => {
			const result = await runCli(
				[
					"intake-source",
					"--title",
					"Agent Intake Patterns",
					"--source-url",
					"https://example.com/intake-surfaces",
					"--source-type",
					"article",
					"--extracted",
					"A complete source about intake as the moment to update topics and ideas.",
					"--coverage",
					"Read full short article; no sections skipped.",
					"--read",
					"Intake should refresh live connection surfaces.",
					"--take",
					"This tightens Stage 3 graph ignition.",
					"--update-surfaces",
					"--json",
				],
				store,
				modelEnv,
			);
			const payload = JSON.parse(result.stdout);

			assert.equal(payload.result.surfaces.status, "updated");
			assert.deepEqual(payload.result.surfaces.topicMaps, ["intake-practice"]);
			assert.equal(payload.result.surfaces.ideas[0].title, "Intake as graph ignition");
			assert.match(await readFile(join(store, "topics", "intake-practice.md"), "utf8"), /Trusted source intake/);
			const ideaFiles = await readdir(join(store, "ideas"));
			assert.equal(ideaFiles.length, 1);
			assert.match(await readFile(join(store, "ideas", ideaFiles[0]), "utf8"), /graph ignition/);
			assert.equal(prompts.length, 2);
		},
	);
});

test("CLI intakes a local path as a world note", async () => {
	const { store } = await gitBackedStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-cli-source-"));
	const source = join(sourceRoot, "local-reference.md");
	await writeFile(source, "# Local Reference\n\nPath feeding makes local docs durable and recallable.\n", "utf8");

	const result = await runCli(["intake-path", "--path", source, "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
	assert.equal(payload.result.sourceType, "local-markdown");
	assert.equal(payload.result.memoryStatus, "active");
	assert.equal(payload.result.truncated, false);
	assert.ok(payload.result.recall.some((note: { id: string }) => note.id === "world/local-reference"));
	const world = await readFile(join(store, "world", "local-reference.md"), "utf8");
	assert.match(world, /Path feeding makes local docs durable/);
	assert.match(world, /Read full local local-markdown file/);
});

test("CLI bootstrap-feed recursively feeds local text sources", async () => {
	const { store } = await gitBackedStore();
	const sourceRoot = await mkdtemp(join(tmpdir(), "her-cli-feed-"));
	await writeFile(join(sourceRoot, "first.md"), "# First Feed\n\nThe first local feed source.\n", "utf8");
	await writeFile(join(sourceRoot, "second.txt"), "# Second Feed\n\nThe second local feed source.\n", "utf8");
	await writeFile(join(sourceRoot, "skip.jpg"), "not text", "utf8");

	const result = await runCli(["bootstrap-feed", "--path", sourceRoot, "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.result.files.length, 2);
	assert.deepEqual(payload.result.files.map((file: { title: string }) => file.title).sort(), [
		"First Feed",
		"Second Feed",
	]);
	assert.match(await readFile(join(store, "world", "first-feed.md"), "utf8"), /first local feed source/);
	assert.match(await readFile(join(store, "world", "second-feed.md"), "utf8"), /second local feed source/);
	assert.equal(
		(await readdir(join(store, "world"))).some((file) => file.includes("skip")),
		false,
	);
});

test("CLI intakes an ordinary URL as a world note", async () => {
	const { store } = await gitBackedStore();

	await withLocalSource(
		{
			body: `<!doctype html>
				<html>
					<head><title>Readable Source</title><script>window.secret = "drop me";</script></head>
					<body>
						<article>
							<h1>Readable Source</h1>
							<p>Readable source content for Her URL intake recall verification.</p>
						</article>
					</body>
				</html>`,
		},
		async (url) => {
			const result = await runCli(["intake-url", "--url", url, "--json"], store, { HER_ALLOW_LOCAL_URLS: "1" });
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
			assert.match(payload.result.contentHash, /^[0-9a-f]{64}$/);
			assert.equal(payload.result.sourceType, "article");
			assert.equal(payload.result.memoryStatus, "active");
			assert.equal(payload.result.truncated, false);
			assert.ok(payload.result.bytesRead > 0);
			assert.ok(payload.result.recall.some((note: { id: string }) => note.id === "world/readable-source"));
			assert.equal(payload.status.status, "unsynced");

			const world = await readFile(join(store, "world", "readable-source.md"), "utf8");
			assert.match(world, /memory_status: active/);
			assert.match(world, /Readable source content for Her URL intake recall verification\./);
			assert.match(world, /Read full fetched article text/);
			assert.doesNotMatch(world, /window\.secret/);
			assert.doesNotMatch(world, /<script>/);
		},
	);
});

test("CLI saves oversized URL intake as needs_deep_read", async () => {
	const { store } = await gitBackedStore();
	const longBody = `# Long URL Fixture\n\n${"This source is longer than the minimal intake byte budget. ".repeat(20)}`;

	await withLocalSource(
		{
			body: longBody,
			contentType: "text/markdown; charset=utf-8",
			path: "/long-url-fixture",
		},
		async (url) => {
			const result = await runCli(["intake-url", "--url", url, "--max-bytes", "80", "--json"], store, {
				HER_ALLOW_LOCAL_URLS: "1",
			});
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.noteId, /^[0-9a-f]{8}$/);
			assert.equal(payload.result.sourceType, "text");
			assert.equal(payload.result.memoryStatus, "needs_deep_read");
			assert.equal(payload.result.truncated, true);
			assert.equal(payload.result.bytesRead, 80);

			const world = await readFile(join(store, "world", "long-url-fixture.md"), "utf8");
			assert.match(world, /memory_status: needs_deep_read/);
			assert.match(world, /memory_status_reason: Fetched text exceeded 80 bytes/);
			assert.match(world, /Orientation only: read first 80 bytes/);
		},
	);
});

test("CLI records judgment and memory status through TS her-core", async () => {
	const { store } = await gitBackedStore();
	const memory = new Memory(store);
	const noteId = await memory.writeWorldNote({
		title: "Interrupt Timing",
		sourceUrl: "https://example.com/interrupt",
		sourceType: "article",
		contentHash: "judgment-cli-fixture",
		memoryStatus: "active",
		extracted: "Interruptions should wait for high-signal moments.",
		coverage: "Read full short fixture.",
		read: "Timing matters more than volume.",
		steal: ["Prefer high-signal interruption windows."],
		connections: ["mirror"],
		take: "Useful for proactive Samantha behavior.",
		possibleMoves: ["Tune proactive trigger thresholds."],
	});

	let result = await runCli(
		[
			"judgment",
			"--note",
			noteId,
			"--choice",
			"Keep the high-signal interruption rule.",
			"--correction",
			"Do not interrupt active work for weak associations.",
			"--json",
		],
		store,
	);
	let payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result, { noteId, recorded: true });
	assert.equal(payload.status.status, "unsynced");

	result = await runCli(
		[
			"memory-status",
			"--note",
			noteId,
			"--status",
			"archive_only",
			"--reason",
			"Useful later but should stay out of active recall for now.",
			"--json",
		],
		store,
	);
	payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result, { noteId, status: "archive_only" });

	const world = await readFile(join(store, "world", "interrupt-timing.md"), "utf8");
	assert.match(world, /choice: Keep the high-signal interruption rule/);
	assert.match(world, /correction: Do not interrupt active work/);
	assert.match(world, /memory_status: archive_only/);
	assert.match(world, /memory_status_reason: Useful later but should stay out of active recall for now\./);
	assert.match(world, /reason: Useful later but should stay out of active recall for now\./);
});

test("CLI recalls active and archived memory as JSON", async () => {
	const { store } = await gitBackedStore();
	await new Memory(store).remember("Harness memory should answer Samantha UI chat.", "note");
	await writeFile(
		join(store, "archive", "semantic", "old-noise.md"),
		"---\ntier: archive\n---\n# Old noise\n\nRecoverable archive memory for later review.\n",
		"utf8",
	);

	let result = await runCli(["recall", "--query", "Samantha UI chat", "--k", "2", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.memoryDir, store);
	assert.equal(payload.result[0].kind, "semantic");
	assert.match(payload.result[0].id, /^semantic\//);
	assert.match(payload.result[0].text, /Samantha UI chat/);

	result = await runCli(["recall", "--query", "Recoverable archive", "--archive", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.result[0].id, "archive/semantic/old-noise");
	assert.equal(payload.result[0].kind, "archive/semantic");
	assert.match(payload.result[0].text, /Recoverable archive memory/);
});

test("CLI recall can use configured embedding search for semantic hits", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "world", "latent.md"),
		"# Latent\n\nA latent concept note without exact query words.\n",
		"utf8",
	);

	await withLocalEmbeddings(async (embeddingEnv, inputs) => {
		const result = await runCli(
			["recall", "--query", "unspoken association", "--k", "1", "--json"],
			store,
			embeddingEnv,
		);
		const payload = JSON.parse(result.stdout);

		assert.equal(payload.result[0].id, "world/latent");
		assert.ok(inputs[0].includes("unspoken association"));
		assert.ok(inputs[0].some((input) => input.includes("id: world/latent")));
	});
});

test("CLI runs TS growth maintenance commands as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, "narrative", "FACTS.md"), "Fei is the owner.\n", "utf8");
	await writeFile(
		join(store, "narrative", "SAMANTHA.md"),
		"# SAMANTHA\n\nSamantha verifies before closing.\n",
		"utf8",
	);
	await writeFile(join(store, "narrative", "CHOICE-MODEL.md"), "# CHOICE MODEL\n\nFei chooses proven work.\n", "utf8");
	await new Memory(store).capture("Fei prefers exact verification before reassurance.", {
		timestamp: "2026-06-05T0900",
		sessionId: "episode-cli",
		project: "her",
	});

	await withLocalChatModel(
		(prompt) => {
			if (prompt.includes("TYPED units")) {
				assert.match(prompt, /episode-cli/);
				return JSON.stringify({
					notes: [
						{
							key: "verification-over-reassurance",
							type: "opinion",
							title: "Verification over reassurance",
							content: "Fei trusts exact verification before reassurance.",
							relations: [{ to: "agent-work-style", rel: "proves" }],
							sources: ["episode-cli"],
						},
					],
					moments: [{ trigger: "completion report", shift: "Samantha should verify before reassurance" }],
				});
			}
			if (prompt.includes("Produce an UPDATED full narrative")) {
				assert.match(prompt, /GROUND-TRUTH FACTS/);
				assert.match(prompt, /SAMANTHA SELF-NARRATIVE/);
				assert.match(prompt, /CHOICE MODEL/);
				return "# CONTEXT\n\nFei values exact verification before reassurance.\n";
			}
			if (prompt.includes("Idea Engine")) {
				assert.match(prompt, /Verification Practice/);
				return JSON.stringify({
					ideas: [
						{
							title: "Verification as care",
							connects: ["verification-over-reassurance"],
							insight: "Reliable close-outs can be relational care.",
							spark: "Make every completion report show evidence first.",
							kind: "self-x-world",
						},
					],
				});
			}
			if (prompt.includes("Group these knowledge units")) {
				assert.match(prompt, /verification-over-reassurance/);
				return JSON.stringify({
					maps: [
						{
							theme: "Verification Practice",
							summary: "Machine truth before closure.",
							members: ["verification-over-reassurance"],
						},
					],
				});
			}
			throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
		},
		async (modelEnv, prompts) => {
			let result = await runCli(["consolidate", "--limit", "1", "--json"], store, modelEnv);
			let payload = JSON.parse(result.stdout);
			assert.deepEqual(payload.result, { episodes: 1, notesTouched: 1, moments: 1 });
			assert.match(
				await readFile(join(store, "semantic", "verification-over-reassurance.md"), "utf8"),
				/exact verification/,
			);

			result = await runCli(["synthesize", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.match(payload.result.proposalId, /^\d{4}-\d{2}-\d{2}-narrative-update$/);
			assert.match(await readFile(join(store, "narrative", "CONTEXT.md"), "utf8"), /exact verification/);

			result = await runCli(["topic-maps", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.deepEqual(payload.result, ["verification-practice"]);
			assert.match(await readFile(join(store, "topics", "verification-practice.md"), "utf8"), /Machine truth/);

			result = await runCli(["ideas", "--json"], store, modelEnv);
			payload = JSON.parse(result.stdout);
			assert.equal(payload.result[0].title, "Verification as care");
			assert.equal(payload.result[0].kind, "self-x-world");
			assert.equal(prompts.length, 4);
		},
	);
});

test("CLI reports synthesize due and approves a proposal as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(join(store, ".her", "state.json"), JSON.stringify({ last_synthesize: "2026-06-01" }), "utf8");
	await writeFile(
		join(store, "semantic", "new-signal.md"),
		'---\nupdated: 2026-06-02\nrelations:\n  - {"to":"old-rule","rel":"conflicts"}\n---\n# New Signal\n\nA conflict should trigger synthesis.\n',
		"utf8",
	);
	await writeFile(join(store, "proposals", "manual.md"), "# CONTEXT\n\nManual proposal from CLI.\n", "utf8");
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: due and proposal fixtures");

	let result = await runCli(["synthesize-due", "--json"], store);
	let payload = JSON.parse(result.stdout);
	assert.equal(payload.result.due, true);
	assert.equal(payload.result.reason, "conflict");

	result = await runCli(["approve", "--proposal", "manual", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.deepEqual(payload.result, { proposalId: "manual", approved: true });
	assert.match(await readFile(join(store, "narrative", "CONTEXT.md"), "utf8"), /Manual proposal from CLI/);
	assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(context\): Approve proposal manual/);
});

test("CLI runs governed archive sweep as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "semantic", "old-noise.md"),
		"---\ntier: decay\nupdated: 2020-01-01\n---\n# Old noise\n\nStale low-value memory.\n",
		"utf8",
	);
	await writeFile(
		join(store, "semantic", "identity.md"),
		"---\ntier: exact\nupdated: 2020-01-01\n---\n# Identity\n\nNever archive exact memory.\n",
		"utf8",
	);

	const result = await runCli(["decay", "--older-than-days", "30", "--now", "2026-06-05", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result.archivedKeys, ["old-noise"]);
	assert.equal(payload.result.archived, 1);
	assert.match(await readFile(join(store, "archive", "semantic", "old-noise.md"), "utf8"), /archived_at: 2026-06-05/);
	assert.match(await readFile(join(store, "semantic", "identity.md"), "utf8"), /Never archive exact memory/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});

test("CLI synthesizes choice model as JSON", async () => {
	const { store } = await gitBackedStore();
	const memory = new Memory(store);
	const noteId = await memory.writeWorldNote({
		title: "Mirror Timing",
		sourceUrl: "https://example.com/mirror-timing",
		sourceType: "article",
		contentHash: "choice-model-cli-fixture",
		memoryStatus: "active",
		extracted: "Fei rejected noisy proactive interruptions.",
		coverage: "Read full short fixture.",
		read: "The source argues timing matters more than volume.",
		steal: ["Quiet timing beats frequent interruption."],
		connections: ["[[semantic/mirror]]"],
		take: "Samantha should wait for high-signal moments.",
		possibleMoves: ["Prefer fewer proactive messages."],
	});
	await memory.recordJudgment(noteId, {
		choice: "Prefer quiet high-signal prompts",
		correction: "Do not treat every related memory as worth interrupting Fei.",
	});
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: choice evidence");

	await withLocalChatModel(
		(prompt) => {
			assert.match(prompt, /CHOICE MODEL/);
			assert.match(prompt, /Prefer quiet high-signal prompts/);
			return "# CHOICE MODEL\n\nPrefer quiet high-signal prompts before interrupting Fei.\n";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(["choice-model", "--json"], store, modelEnv);
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.id, /^[0-9a-f]{8}$/);
			assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
			assert.equal(payload.status.status, "unsynced");
			assert.match(await readFile(join(store, "narrative", "CHOICE-MODEL.md"), "utf8"), /quiet high-signal/);
			assert.match(
				await readFile(join(store, "narrative", "choice-model-log.md"), "utf8"),
				/\[\[world\/mirror-timing\]\]/,
			);
			assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(choice\): Synthesize choice model/);
			assert.equal(prompts.length, 1);
		},
	);
});

test("CLI synthesizes Samantha self narrative as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "narrative", "becoming-moments.md"),
		"- 2026-06-05 · trigger: Fei asked for machine truth · shift: Samantha should verify before reassurance\n",
		"utf8",
	);
	await writeFile(
		join(store, "recognitions", "machine-truth-care.md"),
		"---\nid: rec-cli\nstatus: new\n---\n# Machine Truth Care\n\nVerification helped Fei feel the project was less chaotic.\n",
		"utf8",
	);
	await git(store, "add", "-A");
	await git(store, "commit", "-m", "memory: self evidence");

	await withLocalChatModel(
		(prompt) => {
			assert.match(prompt, /SAMANTHA SELF-EVIDENCE/);
			assert.match(prompt, /Machine Truth Care/);
			return "# SAMANTHA\n\nSamantha treats verification as part of care, not a separate ritual.\n";
		},
		async (modelEnv, prompts) => {
			const result = await runCli(["self-narrative", "--json"], store, modelEnv);
			const payload = JSON.parse(result.stdout);

			assert.match(payload.result.id, /^[0-9a-f]{8}$/);
			assert.match(payload.result.commit, /^[0-9a-f]{7,40}$/);
			assert.equal(payload.status.status, "unsynced");
			assert.match(await readFile(join(store, "narrative", "SAMANTHA.md"), "utf8"), /verification as part of care/);
			const log = await readFile(join(store, "narrative", "self-narrative-log.md"), "utf8");
			assert.match(log, /\[\[narrative\/becoming-moments\]\]/);
			assert.match(log, /\[\[recognitions\/machine-truth-care\]\]/);
			assert.match((await git(store, "log", "--oneline", "-1")).stdout, /memory\(self\): Synthesize self narrative/);
			assert.equal(prompts.length, 1);
		},
	);
});

test("CLI restores an archived semantic note as JSON", async () => {
	const { store } = await gitBackedStore();
	await writeFile(
		join(store, "archive", "semantic", "old-noise.md"),
		"---\ntier: archive\npre_archive_tier: decay\narchived_at: 2026-06-05\n---\n# Old noise\n\nRestore this memory.\n",
		"utf8",
	);

	const result = await runCli(["restore", "--semantic", "old-noise", "--now", "2026-06-06", "--json"], store);
	const payload = JSON.parse(result.stdout);

	assert.equal(payload.memoryDir, store);
	assert.deepEqual(payload.result, { key: "old-noise", restored: true });
	assert.match(await readFile(join(store, "semantic", "old-noise.md"), "utf8"), /restored_at: 2026-06-06/);
	assert.equal(payload.status.status, "unsynced");
	assert.ok(payload.status.dirtyFiles >= 1);
});

test("CLI persists Her long task checkpoints and completion writeback", async () => {
	const { store } = await gitBackedStore();

	let result = await runCli(
		[
			"goal-start",
			"--objective",
			"Ship the resumable long-task base",
			"--source",
			"pi-codex-goal",
			"--next",
			"Run focused tests.",
			"--json",
		],
		store,
	);
	let payload = JSON.parse(result.stdout);
	const id = payload.result.id;
	assert.match(id, /^goal-/);
	assert.equal(payload.result.status, "active");
	assert.equal(payload.result.path, `goals/${id}.md`);

	result = await runCli(
		["goal-next", "--runner", "cli-test", "--lease-minutes", "10", "--now", "2026-06-06T10:00:00.000Z", "--json"],
		store,
	);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.result.id, id);
	assert.equal(payload.result.claimedBy, "cli-test");
	assert.equal(payload.result.claimExpiresAt, "2026-06-06T10:10:00.000Z");

	result = await runCli(
		["goal-next", "--runner", "cli-test-2", "--lease-minutes", "10", "--now", "2026-06-06T10:05:00.000Z", "--json"],
		store,
	);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.result, null);

	result = await runCli(
		[
			"goal-checkpoint",
			"--id",
			id,
			"--summary",
			"Focused tests passed.",
			"--evidence",
			"packages/her/test/cli.test.ts",
			"--next",
			"Commit and push.",
			"--json",
		],
		store,
	);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.result.nextContinuation, "Commit and push.");

	result = await runCli(
		[
			"goal-complete",
			"--id",
			id,
			"--outcome",
			"Committed and pushed.",
			"--remember",
			"Long-task completion should write a durable Her memory when requested.",
			"--json",
		],
		store,
	);
	payload = JSON.parse(result.stdout);
	assert.equal(payload.result.task.status, "completed");
	assert.match(payload.result.memoryNoteId, /^[0-9a-f]{8}$/);
	const memoryNoteId = payload.result.memoryNoteId;

	result = await runCli(["goal-list", "--status", "completed", "--json"], store);
	payload = JSON.parse(result.stdout);
	assert.deepEqual(
		payload.result.map((task: { id: string; status: string }) => [task.id, task.status]),
		[[id, "completed"]],
	);
	assert.match(await readFile(join(store, "goals", `${id}.md`), "utf8"), /Completed/);
	const semanticFiles = await readdir(join(store, "semantic"));
	const memoryFile = semanticFiles.find((file) => file.endsWith(`${memoryNoteId}.md`));
	assert.ok(memoryFile);
	assert.match(await readFile(join(store, "semantic", memoryFile), "utf8"), /Long-task completion/);
});
