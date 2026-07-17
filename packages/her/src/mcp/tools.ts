import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

const ENV_REFERENCE_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DESCRIPTION_LIMIT = 240;
const RESULT_LIMIT = 8000;

export type ConnectorStatus = "ready" | "missing_credentials" | "invalid";

export interface ReadyConnector {
	args: string[];
	command: string;
	env: Record<string, string>;
	label: string;
	secrets: string[];
	slug: string;
	status: "ready";
}

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

function parseConnector(value: unknown, env: NodeJS.ProcessEnv): LoadedConnector {
	if (!isRecord(value)) return connectorProblem(undefined, undefined, "条目必须是对象。");
	const { args, command, env: declaredEnv, label, slug, type } = value;
	if (typeof slug !== "string" || !SLUG_RE.test(slug))
		return connectorProblem(slug, label, "slug 必须为小写字母、数字或连字符。");
	if (typeof label !== "string" || !label.trim()) return connectorProblem(slug, label, "label 不能为空。");
	if (type !== "stdio") return connectorProblem(slug, label, "v1 只支持 stdio connector。");
	if (typeof command !== "string" || !command.trim()) return connectorProblem(slug, label, "command 不能为空。");
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		return connectorProblem(slug, label, "args 必须是字符串数组。");
	}
	if (declaredEnv !== undefined && !isRecord(declaredEnv)) {
		return connectorProblem(slug, label, "env 必须是对象。");
	}

	const resolvedEnv: Record<string, string> = {};
	const missing: string[] = [];
	for (const [key, reference] of Object.entries(declaredEnv ?? {})) {
		if (typeof reference !== "string") return connectorProblem(slug, label, `env.${key} 必须引用环境变量。`);
		const match = reference.match(ENV_REFERENCE_RE);
		if (!match) {
			return connectorProblem(
				slug,
				label,
				reference.startsWith("$") ? `env.${key} 必须是单个 $VAR 引用。` : "密钥必须走环境变量。",
			);
		}
		const name = match[1];
		const resolved = env[name];
		if (!resolved) {
			missing.push(name);
			continue;
		}
		resolvedEnv[key] = resolved;
	}
	if (missing.length > 0) {
		return { slug, label, status: "missing_credentials", reason: `缺少凭据环境变量：${missing.join(", ")}` };
	}

	return {
		slug,
		label,
		status: "ready",
		command: command.trim(),
		args,
		env: resolvedEnv,
		secrets: Object.values(resolvedEnv),
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

function transportEnv(connector: ReadyConnector): Record<string, string> {
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return { ...inherited, ...connector.env };
}

async function withClient<T>(
	connector: ReadyConnector,
	signal: AbortSignal | undefined,
	work: (client: Client, transport: StdioClientTransport) => Promise<T>,
): Promise<T> {
	const transport = new StdioClientTransport({
		command: connector.command,
		args: connector.args,
		env: transportEnv(connector),
		stderr: "pipe",
	});
	const client = new Client({ name: "her-mcp-client", version: "1.0.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { signal });
		return await work(client, transport);
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

function renderToolContent(content: unknown): string {
	const text = Array.isArray(content)
		? content
				.map((item) => {
					if (!isRecord(item) || typeof item.type !== "string") return "[unknown]";
					return item.type === "text" && typeof item.text === "string" ? item.text : `[${item.type}]`;
				})
				.filter(Boolean)
				.join("\n")
		: "";
	return trimText(text || "（外接服务未返回文本）", RESULT_LIMIT);
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
				return await withClient(connector, signal, async (client, transport) => {
					const tools = (await client.listTools(undefined, { signal })).tools;
					const target = tools.find((item) => item.name === params.tool);
					if (!target)
						return textResult(`外接服务 ${connector.slug} 不存在工具：${params.tool}。`, { pid: transport.pid });
					const result = await client.callTool({ name: params.tool, arguments: params.params ?? {} }, undefined, {
						signal,
					});
					const text = renderToolContent(result.content);
					return textResult(result.isError ? `外接工具 ${params.tool} 返回失败：\n${text}` : text, {
						pid: transport.pid,
					});
				});
			} catch (error) {
				return textResult(
					`调用外接服务 ${connector.slug} 的 ${params.tool} 失败。\ntechnical: ${redactError(error, connector)}`,
				);
			}
		},
	});
}
