import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

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
	return { kind: "loaded", connectors: manifest.connectors.map((connector) => parseConnector(connector, env)) };
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
}
