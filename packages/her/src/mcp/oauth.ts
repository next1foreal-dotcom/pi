/**
 * Browser-login for her external services.
 *
 * Until now a connector could only carry a static credential from the
 * environment — you generate a token yourself and paste its NAME into the
 * manifest. That works for services that still hand out personal tokens and
 * not at all for the ones that only accept an interactive grant, which is
 * most of the hosted MCP servers worth connecting.
 *
 * The SDK already ships the protocol half (discovery, dynamic registration,
 * PKCE, refresh). What was missing is the local half: open a browser, catch
 * the redirect, remember the tokens, and refresh them without asking again.
 *
 * Two modes, and the difference matters. Interactive is a human at the
 * keyboard: it may open a browser. Headless is every scheduled run: it must
 * NEVER try, because a hidden task cannot show anyone a login page — it says
 * what to run instead. That is the same failure this repo just spent a day
 * on: the gateway hung forever on a prompt no one could answer.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Where a connector's grant lives. Never in the manifest, never in git. */
export function oauthStorePath(repoRoot: string, slug: string): string {
	return join(repoRoot, ".her", "oauth", `${slug}.json`);
}

interface StoredGrant {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

/** How long a person gets to finish the login before we stop waiting. */
export const LOGIN_TIMEOUT_MS = 3 * 60_000;

export class HeadlessAuthRequired extends Error {
	readonly slug: string;

	constructor(slug: string) {
		super(
			`${slug} 需要登录授权，但现在没有人在场（计划任务里开不了浏览器）。` +
				`请在有人的会话里运行 her_mcp_login {"connector":"${slug}"}，之后它会自己续期。`,
		);
		this.name = "HeadlessAuthRequired";
		this.slug = slug;
	}
}

/**
 * Disk-backed OAuth client for one connector.
 *
 * Everything the flow needs to remember — the dynamically registered client,
 * the PKCE verifier, the tokens — lives in one file per connector so that
 * revoking a service is deleting a file.
 */
export class HerOAuthProvider {
	private cache: StoredGrant | null = null;
	private readonly repoRoot: string;
	private readonly slug: string;
	private readonly label: string;
	/** Set only while a person is waiting; absent means a scheduled run. */
	private readonly interactive?: { redirectUrl: string; onAuthorizationUrl: (url: URL) => void };

	constructor(
		repoRoot: string,
		slug: string,
		label: string,
		interactive?: { redirectUrl: string; onAuthorizationUrl: (url: URL) => void },
	) {
		this.repoRoot = repoRoot;
		this.slug = slug;
		this.label = label;
		this.interactive = interactive;
	}

	get redirectUrl(): string | undefined {
		return this.interactive?.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: `Samantha (${this.label})`,
			redirect_uris: this.interactive ? [this.interactive.redirectUrl] : [],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	private async load(): Promise<StoredGrant> {
		if (this.cache) return this.cache;
		try {
			this.cache = JSON.parse(await readFile(oauthStorePath(this.repoRoot, this.slug), "utf8")) as StoredGrant;
		} catch {
			this.cache = {};
		}
		return this.cache;
	}

	private async save(patch: Partial<StoredGrant>): Promise<void> {
		const grant = { ...(await this.load()), ...patch };
		this.cache = grant;
		const path = oauthStorePath(this.repoRoot, this.slug);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(grant, null, 2)}\n`, "utf8");
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return (await this.load()).clientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		await this.save({ clientInformation });
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.load()).tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.save({ tokens });
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.save({ codeVerifier });
	}

	async codeVerifier(): Promise<string> {
		const stored = (await this.load()).codeVerifier;
		if (!stored) throw new Error(`${this.slug}：没有找到本次登录的校验串，请重新运行 her_mcp_login。`);
		return stored;
	}

	/**
	 * The one place that must refuse to be clever. A scheduled run has no one
	 * to show a login page to; opening a browser there would either do nothing
	 * or hang the task.
	 */
	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.interactive) throw new HeadlessAuthRequired(this.slug);
		this.interactive.onAuthorizationUrl(authorizationUrl);
	}

	/** Drop what the server says is no longer valid, so the next login is clean. */
	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all") {
			await rm(oauthStorePath(this.repoRoot, this.slug), { force: true });
			this.cache = {};
			return;
		}
		const grant = await this.load();
		if (scope === "tokens") grant.tokens = undefined;
		if (scope === "client") grant.clientInformation = undefined;
		if (scope === "verifier") grant.codeVerifier = undefined;
		this.cache = grant;
		await this.save(grant);
	}
}

/** Ask the OS to open the login page. Failure is not fatal — the URL is printed. */
export function openInBrowser(url: string): void {
	try {
		if (process.platform === "win32") {
			spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		} else if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		// The caller always prints the URL too, so a blocked launcher is survivable.
	}
}

export interface LoginCallback {
	redirectUrl: string;
	/** Resolves with the authorization code, or rejects on timeout/denial. */
	waitForCode: Promise<string>;
	close: () => void;
}

/**
 * A one-shot loopback listener for the authorization redirect.
 *
 * Loopback rather than a public callback because the whole point is that the
 * grant never leaves this machine.
 */
export async function startLoginCallback(timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<LoginCallback> {
	let settle: { resolve: (code: string) => void; reject: (error: Error) => void };
	const waitForCode = new Promise<string>((resolve, reject) => {
		settle = { resolve, reject };
	});

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const code = url.searchParams.get("code");
		const error = url.searchParams.get("error");
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(
			`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">${
				code ? "授权完成，可以关掉这一页回到 Samantha。" : `授权没有完成：${error ?? "没有拿到授权码"}`
			}</body>`,
		);
		if (code) settle.resolve(code);
		else settle.reject(new Error(error ?? "授权没有返回授权码"));
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };

	const timer = setTimeout(
		() => settle.reject(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒没有等到授权`)),
		timeoutMs,
	);
	const close = () => {
		clearTimeout(timer);
		server.close();
	};
	void waitForCode.catch(() => undefined).finally(close);

	return { redirectUrl: `http://127.0.0.1:${port}/callback`, waitForCode, close };
}
