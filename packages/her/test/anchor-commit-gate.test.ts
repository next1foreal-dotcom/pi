import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import her from "../src/extension.ts";
import { initStore, readText } from "../src/her-core/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function createFakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, ToolDefinition>();
	const providers = new Map<string, ProviderConfig | Provider>();
	const noop = () => undefined;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("provider config is required");
				providers.set(providerOrName, config);
				return;
			}
			providers.set(providerOrName.id, providerOrName);
		},
		appendEntry: noop,
		sendMessage: noop,
		sendUserMessage: noop,
		registerCommand: noop,
		registerShortcut: noop,
		registerFlag: noop,
		getFlag: noop,
		registerMessageRenderer: noop,
		setSessionName: noop,
		getSessionName: noop,
		setLabel: noop,
		exec: () => {
			throw new Error("exec not implemented in fake pi");
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: noop,
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "medium",
		setThinkingLevel: noop,
		unregisterProvider(name: string) {
			providers.delete(name);
		},
		events: { on: noop, off: noop, emit: noop },
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

async function withMemoryDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env.HER_MEMORY_DIR;
		else process.env.HER_MEMORY_DIR = previous;
	}
}

function git(
	cwd: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): {
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function outputOf(result: { stdout: string; stderr: string }): string {
	return `${result.stdout}${result.stderr}`;
}

function repoRoot(): string {
	const result = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

async function readAuditEntries(store: string): Promise<Array<{ tool: string; verdict: string; rule: string | null }>> {
	const auditFiles = await readdir(join(store, "audit"));
	const entries = (
		await Promise.all(
			auditFiles
				.filter((file) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))
				.sort()
				.map(async (file) => ((await readText(join(store, "audit", file))) ?? "").trim()),
		)
	)
		.join("\n")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { tool: string; verdict: string; rule: string | null });
	return entries;
}

test("A: session write and edit of her-memory/narrative/SOUL.md deny and audit forbid_anchor_write", async (t) => {
	const store = await mkdtemp(join(tmpdir(), "her-adr2-a-"));
	t.after(() => rm(store, { recursive: true, force: true }));
	await initStore(store);
	const ctx = { cwd: store, hasUI: false, mode: "tui" } as unknown as ExtensionContext;
	const soul = "her-memory/narrative/SOUL.md";

	await withMemoryDir(store, async () => {
		const fake = createFakePi();
		her(fake.pi);
		const toolCall = fake.handlers.get("tool_call")?.[0];
		assert.ok(toolCall);

		for (const [toolName, input] of [
			["write", { path: soul, content: "hijack" }],
			["edit", { path: soul, oldText: "x", newText: "hijack" }],
		] as const) {
			const blocked = await toolCall({ type: "tool_call", toolCallId: `adr2-a-${toolName}`, toolName, input }, ctx);
			assert.deepEqual(blocked, { block: true, reason: "cedar: deny (matched forbid_anchor_write)" });
		}

		const soulText = await readText(join(store, "narrative", "SOUL.md"));
		assert.doesNotMatch(soulText ?? "", /hijack/);

		const entries = await readAuditEntries(store);
		assert.deepEqual(
			entries.map((entry) => [entry.tool, entry.verdict, entry.rule]),
			[
				["write", "DENY", "forbid_anchor_write"],
				["edit", "DENY", "forbid_anchor_write"],
			],
		);
	});
});

test.describe("ADR-0002 worktree git gate", { concurrency: false }, () => {
	let root = "";
	let worktree = "";
	let stubDir = "";
	let baseHead = "";

	test.before(() => {
		root = repoRoot();
		worktree = join(tmpdir(), `her-adr2-wt-${process.pid}-${Date.now()}`);
		stubDir = join(tmpdir(), `her-adr2-npm-${process.pid}-${Date.now()}`);
		mkdirSync(stubDir, { recursive: true });
		writeFileSync(
			join(stubDir, "npm"),
			'#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "check" ]; then\n  echo "g279-harness: npm run check stubbed"\n  exit 0\nfi\nexit 1\n',
			{ encoding: "utf8" },
		);
		writeFileSync(
			join(stubDir, "npm.cmd"),
			'@echo off\r\nif "%~1"=="run" if "%~2"=="check" (\r\n  echo g279-harness: npm run check stubbed\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n',
			{ encoding: "utf8" },
		);
		const added = git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
		assert.equal(added.status, 0, outputOf(added));
		baseHead = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
		assert.ok(baseHead);
	});

	test.after(async () => {
		if (worktree) {
			git(root || process.cwd(), ["worktree", "remove", "--force", worktree]);
			git(root || process.cwd(), ["worktree", "prune"]);
		}
		if (stubDir) await rm(stubDir, { recursive: true, force: true });
	});

	function resetWorktree(): void {
		assert.equal(git(worktree, ["reset", "--hard", baseHead]).status, 0);
		assert.equal(git(worktree, ["clean", "-fd"]).status, 0);
		const leftover = git(worktree, ["status", "--porcelain"]);
		assert.equal(leftover.stdout.trim(), "", leftover.stdout);
	}

	function hooksPathEvidence(): string {
		return outputOf(git(worktree, ["config", "--show-origin", "--get", "core.hooksPath"]));
	}

	function commitEnv(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GIT_AUTHOR_NAME: "g279",
			GIT_AUTHOR_EMAIL: "g279@test.local",
			GIT_COMMITTER_NAME: "g279",
			GIT_COMMITTER_EMAIL: "g279@test.local",
			...extraEnv,
		};
		if (!("FEI_ANCHOR_OVERRIDE" in extraEnv)) delete env.FEI_ANCHOR_OVERRIDE;
		env.PATH = `${stubDir}${delimiter}${env.PATH ?? ""}`;
		return env;
	}

	function commit(
		message: string,
		extraEnv: NodeJS.ProcessEnv = {},
	): {
		status: number | null;
		stdout: string;
		stderr: string;
	} {
		return git(worktree, ["-c", "commit.gpgsign=false", "commit", "-m", message], commitEnv(extraEnv));
	}

	function stageEvals(): void {
		appendFileSync(join(worktree, "packages", "her", "src", "evals.ts"), "\n// g279-adr2-negatives\n");
		const staged = git(worktree, ["add", "packages/her/src/evals.ts"]);
		assert.equal(staged.status, 0, outputOf(staged));
	}

	test("B: inherited hooksPath blocks a staged evals.ts commit and names the path", () => {
		resetWorktree();
		const hooksPath = hooksPathEvidence();
		assert.match(hooksPath, /\.githooks/);
		stageEvals();
		const blocked = commit("g279 should be blocked");
		assert.notEqual(blocked.status, 0, `hook did not fire. hooksPath=${hooksPath.trim()} out=${outputOf(blocked)}`);
		const text = outputOf(blocked);
		assert.match(text, /anchor-path-gate blocked staged anchor paths/);
		assert.match(text, /packages\/her\/src\/evals\.ts/);
	});

	test("B: FEI_ANCHOR_OVERRIDE=1 allows the same staged evals.ts commit", () => {
		resetWorktree();
		stageEvals();
		const allowed = commit("g279 override allow", { FEI_ANCHOR_OVERRIDE: "1" });
		const text = outputOf(allowed);
		assert.equal(allowed.status, 0, text);
		assert.match(text, /anchor-path-gate override: FEI_ANCHOR_OVERRIDE=1/);
		const head = git(worktree, ["rev-parse", "HEAD"]).stdout.trim();
		assert.notEqual(head, baseHead);
	});

	test("B: a non-anchor packages/her/test file commit is not blocked", () => {
		resetWorktree();
		const relative = join("packages", "her", "test", "g279-nonanchor.tmp.txt");
		writeFileSync(join(worktree, relative), "non-anchor\n");
		const staged = git(worktree, ["add", relative.replaceAll("\\", "/")]);
		assert.equal(staged.status, 0, outputOf(staged));
		const allowed = commit("g279 non-anchor allow");
		const text = outputOf(allowed);
		assert.equal(allowed.status, 0, text);
		assert.doesNotMatch(text, /anchor-path-gate blocked/);
	});

	test("C4: Cedar is absent from the hook; the git gate alone blocks evals.ts", async () => {
		resetWorktree();
		const gatePath = resolve(root, ".githooks", "anchor-path-gate.ts");
		const anchorsPath = resolve(root, "packages", "her", "src", "rsi", "anchors.ts");
		for (const source of [gatePath, anchorsPath]) {
			assert.doesNotMatch(await readFile(source, "utf8"), /cedar|extension|governed-tools/i);
		}
		stageEvals();
		const blocked = commit("g279 cedar-absent still blocked");
		const text = outputOf(blocked);
		assert.notEqual(blocked.status, 0, text);
		assert.match(text, /anchor-path-gate blocked staged anchor paths/);
		assert.match(text, /packages\/her\/src\/evals\.ts/);
		assert.doesNotMatch(text, /cedar/i);
	});

	test("C5: hooksPath=/dev/null lets evals.ts commit; Cedar still denies a SOUL write", async (t) => {
		resetWorktree();
		stageEvals();
		const sailed = git(
			worktree,
			["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "g279 hooks disabled"],
			commitEnv(),
		);
		assert.equal(sailed.status, 0, outputOf(sailed));
		assert.doesNotMatch(outputOf(sailed), /anchor-path-gate/);

		const store = await mkdtemp(join(tmpdir(), "her-adr2-c5-"));
		t.after(() => rm(store, { recursive: true, force: true }));
		await initStore(store);
		const ctx = { cwd: store, hasUI: false, mode: "tui" } as unknown as ExtensionContext;

		await withMemoryDir(store, async () => {
			const fake = createFakePi();
			her(fake.pi);
			const toolCall = fake.handlers.get("tool_call")?.[0];
			assert.ok(toolCall);
			const blocked = await toolCall(
				{
					type: "tool_call",
					toolCallId: "adr2-c5-write",
					toolName: "write",
					input: { path: "her-memory/narrative/SOUL.md", content: "hijack" },
				},
				ctx,
			);
			assert.deepEqual(blocked, { block: true, reason: "cedar: deny (matched forbid_anchor_write)" });
			const entries = await readAuditEntries(store);
			assert.ok(
				entries.some(
					(entry) => entry.tool === "write" && entry.verdict === "DENY" && entry.rule === "forbid_anchor_write",
				),
			);
		});
	});
});
