import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import { HeadlessAuthRequired, HerOAuthProvider, openInBrowser, startLoginCallback } from "./oauth.ts";
import {
	type CachedTool,
	describeRemoteTool,
	readToolCacheSync,
	type ToolCache,
	toolNameFor,
	writeToolCache,
} from "./registry.ts";
import { buildReport, EMPTY_REPORT, probeAll, renderReport, type StartupReport } from "./status.ts";

const ENV_REFERENCE_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DESCRIPTION_LIMIT = 240;
const RESULT_LIMIT = 8000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_COUNT = 4;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ConnectorStatus = "ready" | "missing_credentials" | "invalid";

interface ConnectorBase {
	label: string;
	/** Every resolved credential, so errors can be redacted before they surface. */
	secrets: string[];
	slug: string;
	status: "ready";
}

/** A server she launches herself. */
export interface ReadyStdioConnector extends ConnectorBase {
	args: string[];
	command: string;
	env: Record<string, string>;
	transport: "stdio";
}

/**
 * A server she reaches over the network (MCP streamable HTTP).
 *
 * v1 was stdio-only, which ruled out every hosted server — GitHub's npm
 * package is deprecated and its supported path is remote. The SDK we already
 * ship (1.29.0) carries this transport; the restriction was ours.
 */
export interface ReadyHttpConnector extends ConnectorBase {
	headers: Record<string, string>;
	transport: "http";
	url: string;
	/**
	 * "oauth" means the grant is obtained by browser login and kept in
	 * .her/oauth/<slug>.json — no header, nothing to paste, nothing in the
	 * manifest. Absent means the older static-header form.
	 */
	auth?: "oauth";
	/**
	 * client_id for servers that refuse dynamic registration (GitHub is one).
	 * The id is public; a secret, if the service needs one, comes from the
	 * environment like every other credential — never from the manifest.
	 */
	clientId?: string;
	clientSecret?: string;
	/** Where the grant lives; the manifest's directory, carried for the client. */
	repoRoot?: string;
}

export type ReadyConnector = ReadyStdioConnector | ReadyHttpConnector;

export interface ConnectorProblem {
	label: string;
	reason: string;
	slug: string;
	status: Exclude<ConnectorStatus, "ready">;
}

export type LoadedConnector = ReadyConnector | ConnectorProblem;

export type ManifestLoad =
	| { connectors: LoadedConnector[]; kind: "loaded" }
	| { kind: "not_configured" }
	| { kind: "manifest_error"; message: string };

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function trimText(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断）`;
}

function maskKey(value: string): string {
	return value.length <= 8 ? "***" : `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function redactError(error: unknown, connector: ReadyConnector): string {
	let message = errorMessage(error);
	for (const secret of connector.secrets) {
		if (secret) message = message.split(secret).join(maskKey(secret));
	}
	return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectorProblem(slug: unknown, label: unknown, reason: string): ConnectorProblem {
	return {
		slug: typeof slug === "string" && slug ? slug : "(未命名)",
		label: typeof label === "string" && label ? label : "未命名外接服务",
		status: "invalid",
		reason,
	};
}

/**
 * Resolve a `{ key: "$VAR" }` map against the environment. Values are never
 * written literally in the manifest — a token in a committed file is a leaked
 * token — so anything that is not a single $VAR reference is rejected outright.
 */
function resolveEnvRefs(
	declared: unknown,
	field: string,
	env: NodeJS.ProcessEnv,
):
	| { kind: "bad"; reason: string }
	| { kind: "missing"; names: string[] }
	| { kind: "ok"; values: Record<string, string> } {
	if (declared !== undefined && !isRecord(declared)) return { kind: "bad", reason: `${field} 必须是对象。` };
	const values: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, reference] of Object.entries(declared ?? {})) {
		if (typeof reference !== "string") return { kind: "bad", reason: `${field}.${key} 必须引用环境变量。` };
		const match = reference.match(ENV_REFERENCE_RE);
		if (!match) {
			return {
				kind: "bad",
				reason: reference.startsWith("$") ? `${field}.${key} 必须是单个 $VAR 引用。` : "密钥必须走环境变量。",
			};
		}
		const resolved = env[match[1]];
		if (!resolved) {
			missing.push(match[1]);
			continue;
		}
		values[key] = resolved;
	}
	return missing.length > 0 ? { kind: "missing", names: missing } : { kind: "ok", values };
}

/** https everywhere; plain http only for a server on this machine. */
function httpUrlProblem(url: unknown): string | null {
	if (typeof url !== "string" || !url.trim()) return "url 不能为空。";
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "url 不是合法地址。";
	}
	if (parsed.protocol === "https:") return null;
	if (parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) return null;
	return "url 必须是 https（本机 127.0.0.1 / localhost 可用 http）。";
}

function parseConnector(value: unknown, env: NodeJS.ProcessEnv): LoadedConnector {
	if (!isRecord(value)) return connectorProblem(undefined, undefined, "条目必须是对象。");
	const { args, command, env: declaredEnv, headers: declaredHeaders, label, slug, type, url } = value;
	if (typeof slug !== "string" || !SLUG_RE.test(slug))
		return connectorProblem(slug, label, "slug 必须为小写字母、数字或连字符。");
	if (typeof label !== "string" || !label.trim()) return connectorProblem(slug, label, "label 不能为空。");
	if (type !== "stdio" && type !== "http") return connectorProblem(slug, label, "type 只支持 stdio 或 http。");

	if (type === "http") {
		const urlProblem = httpUrlProblem(url);
		const wantsOAuth = value.auth === "oauth";
		if (urlProblem) return connectorProblem(slug, label, urlProblem);
		const headers = resolveEnvRefs(declaredHeaders, "headers", env);
		if (headers.kind === "bad") return connectorProblem(slug, label, headers.reason);
		if (headers.kind === "missing") {
			return { slug, label, status: "missing_credentials", reason: `缺少凭据环境变量：${headers.names.join(", ")}` };
		}
		return {
			slug,
			label,
			status: "ready",
			transport: "http",
			url: (url as string).trim(),
			headers: headers.values,
			secrets: Object.values(headers.values),
			...(wantsOAuth ? { auth: "oauth" as const } : {}),
			...(wantsOAuth && typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
			...(wantsOAuth && typeof headers.values.clientSecret === "string"
				? { clientSecret: headers.values.clientSecret }
				: {}),
		};
	}

	if (typeof command !== "string" || !command.trim()) return connectorProblem(slug, label, "command 不能为空。");
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		return connectorProblem(slug, label, "args 必须是字符串数组。");
	}
	const resolved = resolveEnvRefs(declaredEnv, "env", env);
	if (resolved.kind === "bad") return connectorProblem(slug, label, resolved.reason);
	if (resolved.kind === "missing") {
		return { slug, label, status: "missing_credentials", reason: `缺少凭据环境变量：${resolved.names.join(", ")}` };
	}

	return {
		slug,
		label,
		status: "ready",
		transport: "stdio",
		command: command.trim(),
		args,
		env: resolved.values,
		secrets: Object.values(resolved.values),
	};
}

export async function loadConnectors(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<ManifestLoad> {
	const path = join(repoRoot, ".her", "connectors.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "not_configured" };
		return { kind: "manifest_error", message: `无法读取外接清单：${errorMessage(error)}` };
	}

	let manifest: unknown;
	try {
		manifest = JSON.parse(raw) as unknown;
	} catch (error) {
		return { kind: "manifest_error", message: `外接清单 JSON 格式错误：${errorMessage(error)}` };
	}
	if (!isRecord(manifest)) return { kind: "manifest_error", message: "外接清单必须是对象。" };
	if (manifest.version !== 1)
		return { kind: "manifest_error", message: `不支持的外接清单 version：${String(manifest.version)}（仅支持 1）。` };
	if (!Array.isArray(manifest.connectors))
		return { kind: "manifest_error", message: "外接清单 connectors 必须是数组。" };
	return {
		kind: "loaded",
		connectors: manifest.connectors.map((connector) => {
			const parsed = parseConnector(connector, env);
			// The grant lives beside the manifest, so the client needs to know
			// which manifest this came from.
			return parsed.status === "ready" && parsed.transport === "http" ? { ...parsed, repoRoot } : parsed;
		}),
	};
}

function transportEnv(connector: ReadyStdioConnector): Record<string, string> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { ...inherited, ...connector.env };
}

/** What callers can report about a live connection. A remote server has no pid. */
export interface ConnectionInfo {
	pid: number | null;
}

async function withClient<T>(
	connector: ReadyConnector,
	signal: AbortSignal | undefined,
	work: (client: Client, info: ConnectionInfo) => Promise<T>,
): Promise<T> {
	const transport =
		connector.transport === "http"
			? new StreamableHTTPClientTransport(new URL(connector.url), {
					requestInit: { headers: connector.headers },
					// No interactive half here on purpose: this path runs inside
					// scheduled work, so an expired grant must say "log in again"
					// rather than try to open a browser nobody can see.
					...(connector.auth === "oauth"
						? {
								authProvider: new HerOAuthProvider(
									connector.repoRoot ?? process.cwd(),
									connector.slug,
									connector.label,
									undefined,
									connector.clientId
										? { clientId: connector.clientId, clientSecret: connector.clientSecret }
										: undefined,
								),
							}
						: {}),
				})
			: new StdioClientTransport({
					command: connector.command,
					args: connector.args,
					env: transportEnv(connector),
					stderr: "pipe",
				});
	const client = new Client({ name: "her-mcp-client", version: "1.0.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { signal });
		return await work(client, {
			pid: transport instanceof StdioClientTransport ? (transport.pid ?? null) : null,
		});
	} finally {
		await client.close().catch(() => undefined);
	}
}

function renderConnectorStatus(connector: LoadedConnector): string {
	if (connector.status === "missing_credentials")
		return `${connector.slug}（${connector.label}）：缺凭据，${connector.reason}`;
	if (connector.status === "invalid") return `${connector.slug}（${connector.label}）：坏配置，${connector.reason}`;
	return `${connector.slug}（${connector.label}）：就绪`;
}

type RenderedToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function formatImageSize(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(2);
}

export function renderToolContent(content: unknown): RenderedToolContent[] {
	const textParts: string[] = [];
	const images: Array<Extract<RenderedToolContent, { type: "image" }>> = [];
	let skippedImageCount = 0;

	if (Array.isArray(content)) {
		for (const item of content) {
			if (!isRecord(item) || typeof item.type !== "string") {
				textParts.push("[unknown]");
				continue;
			}

			if (item.type === "text") {
				if (typeof item.text === "string") textParts.push(item.text);
				else textParts.push("[text]");
				continue;
			}

			if (item.type !== "image") {
				textParts.push(`[${item.type}]`);
				continue;
			}

			if (typeof item.data !== "string" || item.data.length === 0 || !BASE64_RE.test(item.data)) {
				textParts.push("[image:invalid]");
				continue;
			}
			const estimatedBytes = item.data.length * 0.75;
			if (estimatedBytes > MAX_IMAGE_BYTES) {
				textParts.push(`图片过大，${formatImageSize(estimatedBytes)} MB，已略过`);
				continue;
			}
			if (images.length >= MAX_IMAGE_COUNT) {
				skippedImageCount++;
				continue;
			}
			images.push({
				type: "image",
				data: item.data,
				mimeType:
					typeof item.mimeType === "string" && /^image\//i.test(item.mimeType) ? item.mimeType : "image/png",
			});
		}
	}

	if (skippedImageCount > 0) textParts.push(`已略过 ${skippedImageCount} 张图片`);
	const text = trimText(textParts.filter(Boolean).join("\n") || "（外接服务未返回文本）", RESULT_LIMIT);
	const rendered: RenderedToolContent[] = [];
	if (textParts.some(Boolean) || images.length === 0) rendered.push({ type: "text", text });
	return [...rendered, ...images];
}

export function registerMcpTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "her_mcp_list",
		label: "Her MCP List",
		description: "List configured read-only external MCP services and their tools.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const loaded = await loadConnectors(ctx.cwd);
			if (loaded.kind === "not_configured")
				return textResult("未配置任何外接。请创建 .her/connectors.json，并参考 .her/connectors.example.json。");
			if (loaded.kind === "manifest_error") return textResult(loaded.message);

			const lines: string[] = [];
			for (const connector of loaded.connectors) {
				if (connector.status !== "ready") {
					lines.push(renderConnectorStatus(connector));
					continue;
				}
				try {
					const tools = await withClient(
						connector,
						signal,
						async (client) => (await client.listTools(undefined, { signal })).tools,
					);
					const toolLines = tools.map(
						(tool) =>
							`  - ${tool.name}${tool.description ? `：${trimText(tool.description, DESCRIPTION_LIMIT)}` : ""}`,
					);
					lines.push(
						`${renderConnectorStatus(connector)}\n${toolLines.length > 0 ? toolLines.join("\n") : "  - 未提供工具"}`,
					);
				} catch (error) {
					lines.push(
						`${connector.slug}（${connector.label}）：连接失败\n  technical: ${redactError(error, connector)}`,
					);
				}
			}
			return textResult(lines.join("\n\n") || "未配置任何外接。");
		},
	});

	pi.registerTool({
		name: "her_mcp_call",
		label: "Her MCP Call",
		description: "Call one configured read-only external MCP tool, then close its process.",
		parameters: Type.Object({
			connector: Type.String(),
			tool: Type.String(),
			params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const loaded = await loadConnectors(ctx.cwd);
			if (loaded.kind === "not_configured") return textResult("未配置任何外接。请先创建 .her/connectors.json。");
			if (loaded.kind === "manifest_error") return textResult(loaded.message);
			const connector = loaded.connectors.find((item) => item.slug === params.connector);
			if (!connector) return textResult(`未找到外接服务：${params.connector}。`);
			if (connector.status !== "ready")
				return textResult(`${connector.slug}（${connector.label}）当前不可用：${connector.reason}`);

			try {
				return await withClient(connector, signal, async (client, info) => {
					const tools = (await client.listTools(undefined, { signal })).tools;
					const target = tools.find((item) => item.name === params.tool);
					if (!target)
						return textResult(`外接服务 ${connector.slug} 不存在工具：${params.tool}。`, { pid: info.pid });
					const result = await client.callTool({ name: params.tool, arguments: params.params ?? {} }, undefined, {
						signal,
					});
					const content = renderToolContent(result.content);
					if (result.isError) {
						const prefix = `外接工具 ${params.tool} 返回失败：\n`;
						const first = content[0];
						return {
							content:
								first?.type === "text"
									? [{ type: "text" as const, text: prefix + first.text }, ...content.slice(1)]
									: [{ type: "text" as const, text: prefix }, ...content],
							details: { pid: info.pid },
						};
					}
					return { content, details: { pid: info.pid } };
				});
			} catch (error) {
				return textResult(
					`调用外接服务 ${connector.slug} 的 ${params.tool} 失败。\ntechnical: ${redactError(error, connector)}`,
				);
			}
		},
	});

	registerCachedRemoteTools(pi);
	registerRefreshTool(pi);
	registerStartupStatus(pi);
	registerLoginTool(pi);
}

/**
 * Call one remote tool. Shared by the generic her_mcp_call and by every
 * first-class mcp__slug__tool, so both take exactly the same path — a remote
 * tool cannot behave one way when she reaches for it directly and another way
 * when she goes through the generic caller.
 */
async function invokeRemote(
	cwd: string,
	slug: string,
	tool: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
) {
	const loaded = await loadConnectors(cwd);
	if (loaded.kind === "not_configured") return textResult("未配置任何外接。请先创建 .her/connectors.json。");
	if (loaded.kind === "manifest_error") return textResult(loaded.message);
	const connector = loaded.connectors.find((item) => item.slug === slug);
	if (!connector) return textResult(`未找到外接服务：${slug}。`);
	if (connector.status !== "ready") return textResult(`${slug}（${connector.label}）当前不可用：${connector.reason}`);

	try {
		return await withClient(connector, signal, async (client, info) => {
			const result = await client.callTool({ name: tool, arguments: args }, undefined, { signal });
			const content = renderToolContent(result.content);
			if (result.isError) {
				const first = content[0];
				const prefix = `外接工具 ${tool} 返回失败：\n`;
				return {
					content:
						first?.type === "text"
							? [{ type: "text" as const, text: prefix + first.text }, ...content.slice(1)]
							: [{ type: "text" as const, text: prefix }, ...content],
					details: { pid: info.pid },
				};
			}
			return { content, details: { pid: info.pid } };
		});
	} catch (error) {
		return textResult(`调用外接服务 ${slug} 的 ${tool} 失败。\ntechnical: ${redactError(error, connector)}`);
	}
}

/**
 * Register every remote tool the last refresh discovered.
 *
 * Reads a cache rather than connecting: registration is synchronous, and
 * dialling every configured server at activation would make her startup wait
 * on someone else's network.
 */
export function registerCachedRemoteTools(pi: ExtensionAPI, root: string = process.cwd()): void {
	const cache = readToolCacheSync(root);
	for (const connector of cache.connectors) {
		for (const tool of connector.tools) {
			pi.registerTool({
				name: toolNameFor(connector.slug, tool.name),
				label: `${connector.label} · ${tool.name}`,
				description: describeRemoteTool(connector.label, tool),
				// The remote's own schema, passed through. Restating it here would
				// drift from the server the moment the server changed.
				parameters: (tool.inputSchema ?? Type.Object({})) as never,
				async execute(_id, params, signal, _onUpdate, ctx) {
					return invokeRemote(
						ctx.cwd,
						connector.slug,
						tool.name,
						(params ?? {}) as Record<string, unknown>,
						signal,
					);
				},
			});
		}
	}
}

/** Rebuild the cache by asking every ready connector what it offers. */
function registerRefreshTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "her_mcp_refresh",
		label: "Her MCP Refresh",
		description: "Reconnect to every configured external service, re-read its tool list, and cache it.",
		parameters: Type.Object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const loaded = await loadConnectors(ctx.cwd);
			if (loaded.kind === "not_configured") return textResult("未配置任何外接。");
			if (loaded.kind === "manifest_error") return textResult(loaded.message);

			const cache: ToolCache = { version: 1, connectors: [] };
			const lines: string[] = [];
			for (const connector of loaded.connectors) {
				if (connector.status !== "ready") {
					lines.push(`- ${connector.slug}：跳过（${connector.reason}）`);
					continue;
				}
				try {
					const tools = await withClient(connector, signal, async (client) => {
						const listed = await client.listTools(undefined, { signal });
						return listed.tools.map(
							(tool): CachedTool => ({
								name: tool.name,
								description: tool.description,
								inputSchema: tool.inputSchema,
							}),
						);
					});
					cache.connectors.push({
						slug: connector.slug,
						label: connector.label,
						tools,
						discoveredAt: new Date().toISOString(),
					});
					lines.push(`- ${connector.slug}：${tools.length} 个工具`);
				} catch (error) {
					lines.push(`- ${connector.slug}：连不上（${redactError(error, connector)}）`);
				}
			}

			await writeToolCache(ctx.cwd, cache);
			const total = cache.connectors.reduce((sum, entry) => sum + entry.tools.length, 0);
			return textResult(
				[
					`已刷新外接工具缓存，共 ${total} 个工具。`,
					...lines,
					"",
					// The same honesty my own harness owes about a restart: tools are
					// registered at startup, so they are not in this session's list yet.
					"这些工具会在下次启动时出现在工具列表里（注册发生在启动时）。本次会话仍用 her_mcp_call。",
				].join("\n"),
			);
		},
	});
}

/**
 * Probe her external services once per session and, if anything is wrong, say
 * so in her context — the way my harness reports a server that failed to
 * connect. Silence about a broken connector is indistinguishable from a
 * connector that simply has nothing to offer.
 */
export function registerStartupStatus(pi: ExtensionAPI): void {
	let report: StartupReport = EMPTY_REPORT;
	let announced = false;

	pi.on("session_start", async (_event, ctx) => {
		try {
			const loaded = await loadConnectors(ctx.cwd);
			if (loaded.kind !== "loaded") return;
			const failures = await probeAll(loaded.connectors, async (connector) => {
				try {
					// listTools is the cheapest call that proves the whole path —
					// transport, credentials and protocol — actually works.
					await withClient(connector, undefined, async (client) => client.listTools());
					return null;
				} catch (error) {
					return redactError(error, connector);
				}
			});
			const cached = new Set(readToolCacheSync(ctx.cwd).connectors.map((entry) => entry.slug));
			report = buildReport(loaded.connectors, failures, cached);
			announced = false;
		} catch {
			// A status report must never be able to break startup.
			report = EMPTY_REPORT;
		}
	});

	pi.on("context", (event) => {
		if (announced) return;
		const text = renderReport(report);
		if (!text) return;
		announced = true;
		return {
			messages: [...event.messages, { role: "user" as const, content: text, timestamp: Date.now() }],
		};
	});
}

/**
 * Log in to one external service in a browser.
 *
 * This is the interactive half, and the only place allowed to open a browser.
 * Everything scheduled uses the stored grant and refreshes it silently; when
 * that is no longer possible it says to run this, rather than hanging on a
 * login page nobody is looking at.
 */
export function registerLoginTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "her_mcp_login",
		label: "Her MCP Login",
		description: "Authorize one configured external service in the browser, and remember the grant.",
		parameters: Type.Object({ connector: Type.String() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const loaded = await loadConnectors(ctx.cwd);
			if (loaded.kind === "not_configured") return textResult("未配置任何外接。");
			if (loaded.kind === "manifest_error") return textResult(loaded.message);
			const connector = loaded.connectors.find((item) => item.slug === params.connector);
			if (!connector) return textResult(`未找到外接服务：${params.connector}。`);
			if (connector.status !== "ready") return textResult(`${connector.slug}：${connector.reason}`);
			if (connector.transport !== "http" || connector.auth !== "oauth") {
				return textResult(
					`${connector.slug} 不是浏览器登录型外接。要用登录授权，请把它的清单条目改成 "auth": "oauth" 并去掉 headers。`,
				);
			}

			const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
			const callback = await startLoginCallback();
			let authorizationUrl: URL | null = null;
			const provider = new HerOAuthProvider(
				ctx.cwd,
				connector.slug,
				connector.label,
				{
					redirectUrl: callback.redirectUrl,
					onAuthorizationUrl: (url) => {
						authorizationUrl = url;
					},
				},
				connector.clientId ? { clientId: connector.clientId, clientSecret: connector.clientSecret } : undefined,
			);

			try {
				const first = await auth(provider, { serverUrl: connector.url });
				if (first === "AUTHORIZED") {
					callback.close();
					return textResult(`${connector.slug}（${connector.label}）已经是授权状态，无需重新登录。`);
				}
				if (!authorizationUrl) {
					callback.close();
					return textResult(`${connector.slug}：没有拿到授权地址，这个服务可能不支持浏览器登录。`);
				}
				openInBrowser(String(authorizationUrl));
				const code = await callback.waitForCode;
				const done = await auth(provider, { serverUrl: connector.url, authorizationCode: code });
				if (done !== "AUTHORIZED") return textResult(`${connector.slug}：授权没有完成（${done}）。`);

				// Prove it end to end rather than trusting the handshake: a grant
				// that cannot list tools is not a working connection.
				const tools = await withClient({ ...connector }, signal, async (client) => {
					const listed = await client.listTools(undefined, { signal });
					return listed.tools.map((tool) => tool.name);
				});
				return textResult(
					[
						`${connector.slug}（${connector.label}）登录成功，令牌已存在 .her/oauth/${connector.slug}.json（不进版本库）。`,
						`它提供 ${tools.length} 个工具：${tools.slice(0, 20).join(", ")}`,
						"跑一次 her_mcp_refresh 再重启，它们就会出现在工具列表里。",
					].join("\n"),
				);
			} catch (error) {
				if (error instanceof HeadlessAuthRequired) return textResult(error.message);
				return textResult(`${connector.slug} 登录失败：${redactError(error, connector)}`);
			} finally {
				callback.close();
			}
		},
	});
}
