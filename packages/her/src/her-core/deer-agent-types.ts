/**
 * Vendor-neutral Agent contract matching deer-workflow 0.1.0 `Agent` /
 * `AgentOptions` — kept local so Samantha Node tests do not import the Bun package.
 */

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

export type AgentSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentOptions {
	cwd?: string;
	model?: string;
	schema?: JsonSchema;
	sandbox?: AgentSandbox;
	additionalWritableDirectories?: string[];
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
}

export interface Agent {
	run<TOutput = string>(prompt: string, options?: AgentOptions): Promise<TOutput>;
}

export type AgentFunction = <TOutput = string>(prompt: string, options?: AgentOptions) => Promise<TOutput>;

export function bindAgent(runtime: Agent): AgentFunction {
	return <TOutput = string>(prompt: string, options?: AgentOptions): Promise<TOutput> =>
		runtime.run<TOutput>(prompt, options);
}
