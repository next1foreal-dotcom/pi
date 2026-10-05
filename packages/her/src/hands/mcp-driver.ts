import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CuaCliDriver, type DriverResult, type HandsDriver } from "./driver.ts";
import { record } from "./result.ts";
import { runtimeContractHash } from "./runtime-contract.ts";
import { managedRoot, resolveManagedRuntime } from "./runtime-state.ts";

export interface CuaConnection {
	call(
		name: string,
		input: Record<string, unknown>,
		options: { signal?: AbortSignal; timeout: number },
	): Promise<unknown>;
	close(): Promise<void>;
}
export interface CuaConnectionOptions {
	binary: string;
	socket?: string;
	signal?: AbortSignal;
	timeout: number;
	direct?: boolean;
}
async function connect(options: CuaConnectionOptions): Promise<CuaConnection> {
	const transport = new StdioClientTransport({
		command: options.binary,
		args: options.socket ? ["mcp", "--socket", options.socket] : options.direct ? ["mcp", "--direct"] : ["mcp"],
		stderr: "pipe",
	});
	const client = new Client({ name: "her-cua-host", version: "0.33.3" }, { capabilities: {} });
	// Drain diagnostics without persisting screen content or process-local transport details.
	transport.stderr?.on("data", () => undefined);
	try {
		await client.connect(transport, { signal: options.signal, timeout: options.timeout });
	} catch (error) {
		await client.close();
		throw error;
	}
	return {
		call: (name, input, opts) => client.callTool({ name, arguments: input }, undefined, opts),
		close: () => client.close(),
	};
}
/** One MCP transport per host-owned lifecycle session. Downloads require this live host boundary. */
export class CuaMcpDriver implements HandsDriver {
	readonly #options: { binary: string; defaultTimeoutMs: number; socket?: string; direct?: boolean };
	readonly managementRoot?: string;
	readonly #connect: (options: CuaConnectionOptions) => Promise<CuaConnection>;
	readonly #sessions = new Map<string, CuaConnection>();
	readonly #cli: CuaCliDriver;
	constructor(
		options: { binary: string; defaultTimeoutMs: number; socket?: string; direct?: boolean },
		connectionFactory = connect,
	) {
		this.managementRoot = managedRoot(options.binary);
		if (this.managementRoot && options.socket) throw new Error("Managed CUA owns its runtime; remove driver_socket");
		options = {
			...options,
			binary: resolveManagedRuntime(options.binary, runtimeContractHash),
			direct: !!this.managementRoot || options.direct,
		};
		this.#options = options;
		this.#connect = connectionFactory;
		this.#cli = new CuaCliDriver(options);
	}
	get binary(): string {
		return this.#options.binary;
	}
	async run(args: string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DriverResult> {
		if (args[0] !== "call") return this.#cli.run(args, options);
		const input = record(JSON.parse(args[2] ?? "{}"));
		if (typeof input.session !== "string" && !this.#options.direct) return this.#cli.run(args, options);
		const temporary = typeof input.session !== "string";
		const session = typeof input.session === "string" ? input.session : "temporary-read";
		const timeout = options.timeoutMs ?? this.#options.defaultTimeoutMs;
		const socketIndex = args.indexOf("--socket");
		const socket = socketIndex >= 0 ? args[socketIndex + 1] : this.#options.socket;
		if (this.#options.direct && socket) throw new Error("Direct CUA cannot attach to an external daemon");
		const key = JSON.stringify([socket ?? "", session]);
		options.signal?.throwIfAborted();
		let connection = this.#sessions.get(key);
		try {
			if (!connection) {
				connection = await this.#connect({
					binary: this.#options.binary,
					socket,
					signal: options.signal,
					timeout,
					direct: this.#options.direct,
				});
				this.#sessions.set(key, connection);
			}
			const result = record(await connection.call(args[1], input, { signal: options.signal, timeout }));
			options.signal?.throwIfAborted();
			const contents = Array.isArray(result.content) ? result.content.map(record) : [];
			const first = contents.find((c) => c.type === "text");
			const body = result.structuredContent
				? record(result.structuredContent)
				: record(JSON.parse(String(first?.text ?? "{}")));
			const screenshot = contents.find((c) => c.type === "image");
			if (screenshot && !body.screenshot_png_b64) {
				body.screenshot_png_b64 = screenshot.data;
				body.screenshot_mime_type = screenshot.mimeType;
			}
			if (result.isError) body.isError = true;
			if (args[1] === "end_session" || temporary) {
				this.#sessions.delete(key);
				await connection.close();
			}
			return {
				ok: result.isError !== true,
				exitCode: result.isError ? 1 : 0,
				stdout: JSON.stringify(body),
				stderr: "",
				timedOut: false,
			};
		} catch (error) {
			this.#sessions.delete(key);
			if (connection) {
				try {
					await connection.close();
				} catch (closeError) {
					console.warn("[her-cua] MCP cleanup failed", String(closeError));
				}
			}
			// Never replay: a response lost after dispatch has an unknown effect.
			return {
				ok: false,
				exitCode: null,
				stdout: "",
				stderr: `${String(error)}; transport closed, rebind and verify before retrying`,
				timedOut: /timeout|timed out/i.test(String(error)),
			};
		}
	}
}
