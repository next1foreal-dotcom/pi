import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type OAuthCredential,
	type Provider,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, isOAuthAuthFailure } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const PROVIDER_ID = "g241-fake-oauth";
type TestMode =
	| "oauth-success"
	| "oauth-refresh-fails"
	| "oauth-retry-fails"
	| "oauth-network-error"
	| "oauth-server-error"
	| "api-key";

type TestSession = {
	session: AgentSession;
	runtime: ModelRuntime;
	cleanup: () => void;
	refreshCalls: number;
	requestKeys: string[];
};

function createAssistantMessage(
	model: Model<"openai-completions">,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

async function createTestSession(mode: TestMode): Promise<TestSession> {
	const tempDir = join(tmpdir(), `pi-g241-auth-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model: Model<"openai-completions"> = {
		id: "fake-model",
		name: "Fake model",
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://fake.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	};

	const initialCredential: OAuthCredential = {
		type: "oauth",
		refresh: "refresh-token",
		access: "stale-token",
		expires: Date.now() + 30 * 60 * 1000,
	};
	let refreshCalls = 0;
	const requestKeys: string[] = [];
	const authStorage = AuthStorage.inMemory(
		mode === "api-key"
			? { [PROVIDER_ID]: { type: "api_key", key: "api-key" } }
			: { [PROVIDER_ID]: initialCredential },
	);

	const oauth = {
		name: "G241 fake OAuth",
		login: async () => initialCredential,
		refresh: async (credential: OAuthCredential): Promise<OAuthCredential> => {
			refreshCalls++;
			if (mode === "oauth-refresh-fails") throw new Error("fake refresh failed");
			return { ...credential, access: "fresh-token", expires: Date.now() + 2 * 60 * 60 * 1000 };
		},
		toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
	};

	const stream = <T extends Api>(_model: Model<T>, _context: Context, options?: ApiStreamOptions<T>) => {
		requestKeys.push((options as SimpleStreamOptions | undefined)?.apiKey ?? "");
		const eventStream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const requestNumber = requestKeys.length;
			const failed =
				mode === "oauth-network-error" || mode === "oauth-server-error"
					? true
					: mode === "oauth-retry-fails"
						? true
						: mode === "api-key"
							? true
							: requestNumber === 1;
			const errorMessage =
				mode === "oauth-network-error"
					? "network error"
					: mode === "oauth-server-error"
						? "HTTP 500: server error"
						: requestNumber === 1
							? "HTTP 401: Provided authentication token is expired"
							: "HTTP 401: invalid_token";
			const message = failed
				? createAssistantMessage(model, { stopReason: "error", errorMessage })
				: createAssistantMessage(model, { content: [{ type: "text", text: "Recovered" }] });
			eventStream.push({ type: "start", partial: message });
			eventStream.push(
				failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message },
			);
		});
		return eventStream;
	};

	const provider: Provider<"openai-completions"> = {
		id: PROVIDER_ID,
		name: "G241 fake provider",
		auth:
			mode === "api-key"
				? {
						apiKey: {
							name: "G241 fake API key",
							resolve: async ({ credential }) =>
								credential?.key ? { auth: { apiKey: credential.key }, source: "G241 fake API key" } : undefined,
						},
					}
				: { oauth },
		getModels: () => [model],
		stream,
		streamSimple: stream,
	};

	const runtime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(provider);
	await runtime.refresh({ allowNetwork: false });

	const agent = new Agent({
		initialState: { model, systemPrompt: "Test", tools: [] },
		streamFn: runtime.streamSimple.bind(runtime),
	});
	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 3, baseDelayMs: 1 } });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: runtime,
		resourceLoader: createTestResourceLoader(),
	});

	return {
		session,
		runtime,
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		},
		get refreshCalls() {
			return refreshCalls;
		},
		requestKeys,
	};
}

describe("G-241 OAuth 401 refresh retry", () => {
	let current: TestSession | undefined;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		current?.cleanup();
		current = undefined;
	});

	it("classifies only the authorized 401/token-expired signatures", () => {
		expect(isOAuthAuthFailure("HTTP 401")).toBe(true);
		expect(isOAuthAuthFailure("Provided authentication token is expired")).toBe(true);
		expect(isOAuthAuthFailure("invalid_token")).toBe(true);
		expect(isOAuthAuthFailure("expired card")).toBe(false);
		expect(isOAuthAuthFailure("quota exceeded")).toBe(false);
		expect(isOAuthAuthFailure("HTTP 400: invalid parameter")).toBe(false);
	});

	it("forces one OAuth refresh and retries once with headers resolved again", async () => {
		current = await createTestSession("oauth-success");
		// stderr keeps print mode's stdout NDJSON stream parseable.
		const info = vi.spyOn(console, "error").mockImplementation(() => {});

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(1);
		expect(current.requestKeys).toEqual(["stale-token", "fresh-token"]);
		expect(current.session.agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(info).toHaveBeenCalledWith("[pi-auth] forced oauth refresh + single retry for g241-fake-oauth");
	});

	it("surfaces the original 401 when the forced refresh fails without resending", async () => {
		current = await createTestSession("oauth-refresh-fails");

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(1);
		expect(current.requestKeys).toEqual(["stale-token"]);
		expect(current.session.agent.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "HTTP 401: Provided authentication token is expired",
		});
	});

	it("does not start a second round when the resent request is still 401", async () => {
		current = await createTestSession("oauth-retry-fails");

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(1);
		expect(current.requestKeys).toEqual(["stale-token", "fresh-token"]);
		expect(current.session.agent.state.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "HTTP 401: invalid_token",
		});
	});

	it("leaves OAuth network errors on the existing no-forced-refresh path", async () => {
		current = await createTestSession("oauth-network-error");

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(0);
		expect(current.requestKeys).toHaveLength(1);
	});

	it("leaves OAuth 5xx errors on the existing no-forced-refresh path", async () => {
		current = await createTestSession("oauth-server-error");

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(0);
		expect(current.requestKeys).toHaveLength(1);
	});

	it("does not refresh or resend API-key 401 responses", async () => {
		current = await createTestSession("api-key");

		await current.session.prompt("Test");

		expect(current.refreshCalls).toBe(0);
		expect(current.requestKeys).toHaveLength(1);
	});
});
