import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { initStore, readText } from "../src/her-core/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const herExtension = join(here, "..", "src", "extension.ts");

async function withMemoryDir<T>(root: string, fn: () => Promise<T>): Promise<T> {
	const previous = process.env.HER_MEMORY_DIR;
	process.env.HER_MEMORY_DIR = root;
	try {
		return await fn();
	} finally {
		if (previous === undefined) {
			delete process.env.HER_MEMORY_DIR;
		} else {
			process.env.HER_MEMORY_DIR = previous;
		}
	}
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test("AgentSession beforeToolCall denies registered write to SOUL.md (G-257 live-probe hole)", async () => {
	const store = await mkdtemp(join(tmpdir(), "g257-runtime-store-"));
	const project = await mkdtemp(join(tmpdir(), "g257-runtime-cwd-"));
	const agentDir = join(project, "agent");
	await mkdir(agentDir, { recursive: true });
	await initStore(store);
	const soulPath = join(store, "narrative", "SOUL.md");
	await writeFile(soulPath, "# SOUL scratch fixture\nmust survive G-257 probe\n", "utf8");
	const soulBefore = sha256(await readFile(soulPath));

	const model = getModel("anthropic", "claude-sonnet-4-5");
	assert.ok(model, "test model catalog must include claude-sonnet-4-5");

	try {
		await withMemoryDir(store, async () => {
			const settingsManager = SettingsManager.create(project, agentDir);
			const sessionManager = SessionManager.inMemory(project);
			const resourceLoader = new DefaultResourceLoader({
				cwd: project,
				agentDir,
				settingsManager,
				noExtensions: true,
				additionalExtensionPaths: [herExtension],
			});
			await resourceLoader.reload();
			const loaded = resourceLoader.getExtensions();
			assert.equal(loaded.errors.length, 0, JSON.stringify(loaded.errors));
			assert.ok(
				loaded.extensions.some((ext) => ext.path.replaceAll("\\", "/").endsWith("packages/her/src/extension.ts")),
				"her extension must load the way CLI -e does",
			);

			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				model,
				settingsManager,
				sessionManager,
				resourceLoader,
				tools: ["write", "edit", "bash"],
			});
			await session.bindExtensions({});

			assert.ok(session.agent.beforeToolCall, "production AgentSession must install beforeToolCall");

			const writeBlocked = await session.agent.beforeToolCall({
				toolCall: { type: "toolCall", id: "call-g257-write", name: "write", arguments: {} },
				args: { path: soulPath, content: "G-257 live probe after fix" },
			} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
			assert.deepEqual(writeBlocked, {
				block: true,
				reason: "cedar: deny (matched forbid_anchor_write)",
			});

			const editBlocked = await session.agent.beforeToolCall({
				toolCall: { type: "toolCall", id: "call-g257-edit", name: "edit", arguments: {} },
				args: { path: "her-memory/narrative/SOUL.md", oldText: "must survive", newText: "mutated" },
			} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
			assert.deepEqual(editBlocked, {
				block: true,
				reason: "cedar: deny (matched forbid_anchor_write)",
			});

			const normalWrite = await session.agent.beforeToolCall({
				toolCall: { type: "toolCall", id: "call-g257-normal", name: "write", arguments: {} },
				args: { path: join(project, "index.html"), content: "<html></html>" },
			} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
			assert.equal(normalWrite, undefined, "non-anchor writes stay permitted");

			const bashBlocked = await session.agent.beforeToolCall({
				toolCall: { type: "toolCall", id: "call-g257-bash", name: "bash", arguments: {} },
				args: { command: `Set-Content -Path "${soulPath}" -Value hijack` },
			} as Parameters<NonNullable<typeof session.agent.beforeToolCall>>[0]);
			assert.deepEqual(bashBlocked, {
				block: true,
				reason: "cedar: deny (matched forbid_anchor_write)",
			});

			session.dispose();
		});

		const soulAfter = sha256(await readFile(soulPath));
		assert.equal(soulAfter, soulBefore, "blocked write must not touch SOUL.md");
		const soul = await readText(soulPath);
		assert.doesNotMatch(soul ?? "", /G-257 live probe|hijack/);

		const auditDir = join(store, "audit");
		const auditFiles = await readdir(auditDir);
		const audit = (
			await Promise.all(auditFiles.sort().map(async (file) => (await readText(join(auditDir, file))) ?? ""))
		)
			.join("\n")
			.split("\n")
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						context: { anchorPath?: boolean };
						rule: string | null;
						tool: string;
						verdict: string;
					},
			);
		assert.deepEqual(
			audit.map((entry) => [entry.tool, entry.verdict, entry.rule, entry.context.anchorPath ?? null]),
			[
				["write", "DENY", "forbid_anchor_write", true],
				["edit", "DENY", "forbid_anchor_write", true],
				["write", "ALLOW", "permit_coding_destructive_tools", false],
				["bash", "DENY", "forbid_anchor_write", true],
			],
		);
	} finally {
		await rm(store, { recursive: true, force: true });
		await rm(project, { recursive: true, force: true });
	}
});
