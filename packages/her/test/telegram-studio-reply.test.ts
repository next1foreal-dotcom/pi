import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	deliverTelegramStudioReplies,
	pushTelegramOutbox,
	queueTelegramInbound,
	telegramStudioReplySignature,
} from "../src/her-core/telegram.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-studio-reply-"));
	roots.push(root);
	return root;
}

after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function withStudio(
	handler: (body: string, headers: Record<string, string | string[] | undefined>) => { status: number; body: unknown },
	fn: (url: string) => Promise<void>,
): Promise<void> {
	const server = createServer((req, res) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const result = handler(body, req.headers);
			res.writeHead(result.status, { "content-type": "application/json" });
			res.end(JSON.stringify(result.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing server address");
	try {
		await fn(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

test("Studio replies are signed, retried from durable inbox, and delivered once", async () => {
	const root = await tempRoot();
	const queued = await queueTelegramInbound(root, {
		allowedChatId: "42",
		now: "2026-09-26T12:00:00Z",
		update: {
			update_id: 7001,
			message: { message_id: 3, chat: { id: 42 }, from: { id: 42 }, text: "REPLY ASK-7K2P 选:A" },
		},
	});
	let calls = 0;
	await withStudio(
		(body, headers) => {
			calls += 1;
			assert.equal(headers["x-her-telegram-signature"], telegramStudioReplySignature(body, "test-token"));
			const payload = JSON.parse(body) as Record<string, unknown>;
			assert.deepEqual(payload, { chatId: "42", code: "ASK-7K2P", text: "选:A", updateId: 7001 });
			return calls === 1
				? { status: 503, body: { ok: false, status: "retry", reason: "offline" } }
				: { status: 200, body: { ok: true, status: "delivered", workspaceId: "session-1" } };
		},
		async (studioUrl) => {
			let result = await deliverTelegramStudioReplies(root, {
				allowedChatId: "42",
				studioUrl,
				token: "test-token",
			});
			assert.deepEqual(
				result.map((item) => item.status),
				["retry"],
			);

			result = await deliverTelegramStudioReplies(root, {
				allowedChatId: "42",
				studioUrl,
				token: "test-token",
			});
			assert.deepEqual(
				result.map((item) => item.status),
				["delivered"],
			);
			assert.equal(result[0]?.workspaceId, "session-1");

			result = await deliverTelegramStudioReplies(root, {
				allowedChatId: "42",
				studioUrl,
				token: "test-token",
			});
			assert.deepEqual(result, []);
		},
	);
	assert.equal(calls, 2);
	const inbox = await readFile(join(root, queued.path!), "utf8");
	assert.match(inbox, /status: delivered/);
	assert.match(inbox, /delivered_at:/);
});

test("non-allowlisted Telegram messages never become Studio replies", async () => {
	const root = await tempRoot();
	const queued = await queueTelegramInbound(root, {
		allowedChatId: "42",
		update: { update_id: 7002, message: { chat: { id: 99 }, text: "REPLY ASK-7K2P allow" } },
	});
	assert.equal(queued.status, "rejected");
	assert.deepEqual(
		await deliverTelegramStudioReplies(root, {
			allowedChatId: "42",
			studioUrl: "http://127.0.0.1:1",
			token: "test-token",
		}),
		[],
	);
});

test("resident bridge selects meaningful typed notices and leaves legacy backlog quiet", async () => {
	const root = await tempRoot();
	await mkdir(join(root, "outbox"), { recursive: true });
	await writeFile(join(root, "outbox", "2026-01-01-heartbeat.md"), "# old heartbeat\n", "utf8");
	await writeFile(
		join(root, "outbox", "2026-09-26-studio-ask.md"),
		"---\ntype: studio-ask-wait\nstatus: pending\n---\n\n# reply needed\n",
		"utf8",
	);
	const sent: string[] = [];
	const result = await pushTelegramOutbox(root, {
		chatId: "42",
		includeTypes: ["studio-ask-wait"],
		token: "test-token",
		fetch: async (_url, init) => {
			sent.push(String(init?.body));
			return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
		},
	});
	assert.equal(result.sent.length, 1);
	assert.match(result.sent[0]?.path ?? "", /studio-ask/);
	assert.equal(
		result.skipped.some((item) => item.reason === "type not selected"),
		true,
	);
	assert.equal(sent.length, 1);
});
