import { mkdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT_BROWSER_LOCK_DIR = join(tmpdir(), "her-agent-browser-e2e.lock");
const AGENT_BROWSER_LOCK_TIMEOUT_MS = 300_000;
const AGENT_BROWSER_LOCK_STALE_MS = 300_000;
const SAFE_PORT_MIN = 20_000;
const SAFE_PORT_MAX = 40_000;

export async function withAgentBrowserTestLock(run: () => Promise<void>): Promise<void> {
	const startedAt = Date.now();
	while (true) {
		try {
			await mkdir(AGENT_BROWSER_LOCK_DIR);
			break;
		} catch (error) {
			if (!isAlreadyExists(error)) throw error;
			const lock = await stat(AGENT_BROWSER_LOCK_DIR).catch(() => undefined);
			if (lock && Date.now() - lock.mtimeMs > AGENT_BROWSER_LOCK_STALE_MS) {
				await rm(AGENT_BROWSER_LOCK_DIR, { force: true, recursive: true }).catch(() => undefined);
				continue;
			}
			if (Date.now() - startedAt > AGENT_BROWSER_LOCK_TIMEOUT_MS) {
				throw new Error("timed out waiting for the agent-browser e2e test lock");
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		}
	}
	try {
		await run();
	} finally {
		await rm(AGENT_BROWSER_LOCK_DIR, { force: true, recursive: true });
	}
}

export async function withSafeFixtureServer(html: string, run: (url: string) => Promise<void>): Promise<void> {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(html);
	});
	let port = safePort();
	try {
		try {
			await listen(server, port);
		} catch (error) {
			if (!isAddressInUse(error)) throw error;
			port = safePort();
			await listen(server, port);
		}
		await run(`http://127.0.0.1:${port}/fixture`);
	} finally {
		await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	}
}

function safePort(): number {
	return SAFE_PORT_MIN + Math.floor(Math.random() * (SAFE_PORT_MAX - SAFE_PORT_MIN + 1));
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
	return new Promise<void>((resolvePromise, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolvePromise();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, "127.0.0.1");
	});
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isAddressInUse(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}
