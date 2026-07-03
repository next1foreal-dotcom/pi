import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { storeLock } from "../src/her-core/store-lock.ts";

const repoRoot = process.env.HER_REPO_ROOT ?? resolve(process.cwd(), "..");
const herCoreRoot = join(repoRoot, "her-core");
const venvPython = join(herCoreRoot, ".venv", "Scripts", process.platform === "win32" ? "python.exe" : "python");
const python = process.env.HER_TEST_PYTHON ?? (existsSync(venvPython) ? venvPython : "python");
const pythonEnv = { ...process.env, PYTHONPATH: herCoreRoot };

interface PythonResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	stdout: string;
}

async function tempStore(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "her-cross-engine-lock-"));
	await mkdir(join(root, ".her"), { recursive: true });
	return root;
}

async function requirePythonHerCore(t: TestContext): Promise<boolean> {
	try {
		await access(join(herCoreRoot, "her", "store.py"));
	} catch {
		t.skip(`her-core not found at ${herCoreRoot}`);
		return false;
	}
	const result = await runPython("import her.store; print('ok')", {}, 2_000);
	if (result.code !== 0) {
		t.skip(`python her-core import unavailable: ${(result.stderr || result.stdout).trim()}`);
		return false;
	}
	return true;
}

function runPython(script: string, env: Record<string, string> = {}, timeoutMs = 5_000): Promise<PythonResult> {
	return new Promise((resolve) => {
		const child = spawn(python, ["-c", script], {
			env: { ...pythonEnv, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let stderr = "";
		let stdout = "";
		const finish = (result: PythonResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish({ code: null, signal: null, stderr: `${stderr}\npython timed out`, stdout });
		}, timeoutMs);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			finish({ code: null, signal: null, stderr: `${stderr}\n${error.message}`, stdout });
		});
		child.on("close", (code, signal) => {
			finish({ code, signal, stderr, stdout });
		});
	});
}

function spawnPythonLockHolder(
	root: string,
	holdSeconds: number,
): {
	child: ChildProcessWithoutNullStreams;
	stderr: () => string;
} {
	const child = spawn(
		python,
		[
			"-c",
			[
				"import os, time",
				"from pathlib import Path",
				"from her.store import store_lock",
				"lock = Path(os.environ['HER_TEST_STORE']) / '.her' / 'lock'",
				"with store_lock(lock, timeout=2, stale_after=9999, poll=0.05):",
				"    print('ready', flush=True)",
				"    time.sleep(float(os.environ['HER_TEST_HOLD_SECONDS']))",
			].join("\n"),
		],
		{
			env: { ...pythonEnv, HER_TEST_HOLD_SECONDS: String(holdSeconds), HER_TEST_STORE: root },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	child.stdin.end();
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	return { child, stderr: () => stderr };
}

function waitForStdout(child: ChildProcessWithoutNullStreams, expected: string, stderr: () => string): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		const timer = setTimeout(() => {
			reject(new Error(`timed out waiting for ${expected}; stdout=${stdout}; stderr=${stderr()}`));
		}, 2_000);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.includes(expected)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			reject(new Error(`python exited before ${expected}: code=${code} signal=${signal}; stderr=${stderr()}`));
		});
	});
}

function waitForExit(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve) => {
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("TS storeLock waits while Python store_lock holds the shared lock", async (t) => {
	if (!(await requirePythonHerCore(t))) return;
	const root = await tempStore();
	const holder = spawnPythonLockHolder(root, 0.5);
	try {
		await waitForStdout(holder.child, "ready", holder.stderr);
		let acquired = false;
		const pending = storeLock(
			root,
			async () => {
				acquired = true;
			},
			{ pollMs: 20, staleAfterMs: 999_000, timeoutMs: 2_000 },
		);

		await sleep(100);
		assert.equal(acquired, false);
		const exit = await waitForExit(holder.child);
		assert.equal(exit.code, 0, holder.stderr());
		await pending;
		assert.equal(acquired, true);
	} finally {
		holder.child.kill();
	}
});

test("Python store_lock times out while TS storeLock holds the shared lock", async (t) => {
	if (!(await requirePythonHerCore(t))) return;
	const root = await tempStore();
	await storeLock(
		root,
		async () => {
			const result = await runPython(
				[
					"import os, sys",
					"from pathlib import Path",
					"from her.store import store_lock",
					"lock = Path(os.environ['HER_TEST_STORE']) / '.her' / 'lock'",
					"try:",
					"    with store_lock(lock, timeout=0.3, stale_after=9999, poll=0.05):",
					"        print('unexpected acquire')",
					"except TimeoutError as exc:",
					"    print(str(exc), file=sys.stderr)",
					"    raise SystemExit(42)",
					"raise SystemExit(1)",
				].join("\n"),
				{ HER_TEST_STORE: root },
				2_000,
			);
			assert.equal(result.code, 42, result.stderr || result.stdout);
			assert.match(`${result.stdout}\n${result.stderr}`, /store lock held by/);
		},
		{ pollMs: 20, staleAfterMs: 999_000, timeoutMs: 1_000 },
	);
});
