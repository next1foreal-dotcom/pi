import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTasks, parseCatalog, scoreTask, type ExamCatalog, type ExamTask, type ExecutionStatus, type TaskResult } from "./score.ts";
import { parseToolCalls } from "./transcript.ts";
import { writeReport } from "./report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const EXAM_ROOT = resolve(HERE);
const FIXTURE_ROOT = join(EXAM_ROOT, "fixtures");
const RESULTS_ROOT = join(EXAM_ROOT, "results");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };

export type SpawnResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
export type FixtureServer = { baseUrl: string; close: () => Promise<void> };

export function resolveUiBase(env: NodeJS.ProcessEnv = process.env): string {
	return env.HER_UI_BASE_URL ?? "http://127.0.0.1:3000";
}

export function resolvePiCliPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.HER_EXAM_PI_CLI?.trim() || env.HER_DEER_PI_CLI?.trim();
	return override ? resolve(override) : join(REPO_ROOT, "packages", "coding-agent", "dist", "cli.js");
}

export function buildPiArgs(opts: { cliPath: string; prompt: string; allowTools: string[]; provider?: string; model?: string; env?: NodeJS.ProcessEnv }): string[] {
	const env = opts.env ?? process.env;
	const provider = opts.provider?.trim() || env.HER_EXAM_PROVIDER?.trim() || "openai";
	const model = opts.model?.trim() || env.HER_EXAM_MODEL?.trim() || "gpt-5.6";
	return [opts.cliPath, "--print", "--mode", "json", "--provider", provider, "--model", model, opts.prompt, "--tools", opts.allowTools.join(",")];
}

export function composePrompt(task: ExamTask, fixtureBaseUrl: string, outDirAbs: string, preamble: string): string {
	const prompt = task.prompt.replaceAll("{{FIXTURE_URL}}", fixtureBaseUrl).replaceAll("{{OUT_DIR}}", outDirAbs);
	return `${preamble.replaceAll("{{OUT_DIR}}", outDirAbs).trim()}\n\n${prompt}`;
}

export async function preflight(opts: { uiBase?: string; model?: string; fetchImpl?: typeof fetch } = {}): Promise<void> {
	const model = opts.model?.trim() || process.env.HER_EXAM_MODEL?.trim() || "gpt-5.6";
	if (/deepseek/i.test(model)) throw new Error(`deepseek model is refused for hands exam: ${model}`);
	const fetchImpl = opts.fetchImpl ?? fetch;
	let response: Response;
	try {
		response = await fetchImpl(`${opts.uiBase ?? resolveUiBase()}/api/browser/agent-read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxChars: 500 }) });
	} catch (error) {
		throw new Error(`Studio is not running; the exam will not start it: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`Studio is not running or browser host is unavailable; the exam will not start it: HTTP ${response.status}`);
}

export function resolveFixturePath(root: string, requestPath: string): { status: number; path?: string; mime?: string } {
	let decoded: string;
	try {
		decoded = decodeURIComponent(requestPath.split("?")[0] ?? "");
	} catch {
		return { status: 403 };
	}
	if (!decoded.startsWith("/") || isAbsolute(decoded.replace(/^\//, "")) || /^[a-zA-Z]:/.test(decoded.replace(/^\//, ""))) return { status: 403 };
	const target = resolve(root, `.${decoded}`);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { status: 403 };
	const mime = MIME[extname(target).toLowerCase()];
	if (!mime) return { status: 404 };
	return { status: 200, path: target, mime };
}

export async function startFixtureServer(root = FIXTURE_ROOT): Promise<FixtureServer> {
	const server = createServer(async (request, response) => {
		const resolved = resolveFixturePath(root, request.url ?? "");
		if (resolved.status !== 200 || !resolved.path || !resolved.mime) {
			response.writeHead(resolved.status);
			response.end();
			return;
		}
		try {
			const info = await stat(resolved.path);
			if (!info.isFile() || lstatSync(resolved.path).isSymbolicLink()) {
				response.writeHead(404);
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": resolved.mime, "cache-control": "no-store" });
			response.end(await readFile(resolved.path));
		} catch {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolvePromise();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not receive a TCP port");
	return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())) };
}

export async function spawnHer(opts: { prompt: string; cwd: string; allowTools: string[]; timeoutMs: number; model?: string; provider?: string; env?: NodeJS.ProcessEnv }): Promise<SpawnResult> {
	const env = opts.env ?? process.env;
	const cliPath = resolvePiCliPath(env);
	if (!existsSync(cliPath)) throw new Error(`pi CLI not found at ${cliPath}`);
	const args = buildPiArgs({ cliPath, prompt: opts.prompt, allowTools: opts.allowTools, provider: opts.provider, model: opts.model, env });
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
		const timer = setTimeout(() => {
			timedOut = true;
			if (process.platform === "win32" && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			else child.kill();
		}, opts.timeoutMs);
		child.once("error", (error) => { clearTimeout(timer); reject(error); });
		child.once("close", (exitCode) => { clearTimeout(timer); resolvePromise({ exitCode, stdout, stderr, timedOut }); });
	});
}

async function sha256Path(path: string): Promise<string> {
	const hash = createHash("sha256");
	async function add(current: string): Promise<void> {
		const info = await stat(current);
		if (info.isDirectory()) {
			for (const child of (await readdir(current)).sort()) {
				hash.update(relative(path, join(current, child)));
				await add(join(current, child));
			}
			return;
		}
		hash.update(await readFile(current));
	}
	await add(path);
	return hash.digest("hex");
}

async function gitSha(): Promise<string> {
	try {
		const dotGit = join(REPO_ROOT, ".git");
		const locator = await readFile(dotGit, "utf8");
		const gitDir = locator.startsWith("gitdir: ") ? resolve(REPO_ROOT, locator.slice(8).trim()) : dotGit;
		const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
		return head.startsWith("ref: ") ? (await readFile(join(gitDir, head.slice(5)), "utf8")).trim() : head;
	} catch {
		return "unknown";
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeResultAtomic(runDir: string, taskId: string, result: TaskResult): Promise<void> {
	const finalPath = join(runDir, `${taskId}.json`);
	const temporary = `${finalPath}.tmp`;
	await writeJson(temporary, result);
	await rename(temporary, finalPath);
}

function classifyNetworkFailure(task: ExamTask, text: string): ExecutionStatus {
	return task.network && /(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|TLS|CERT_|SSL)/i.test(text) ? "ENV_FAIL" : "SPAWN_ERROR";
}

export async function validateCatalogAndFixtures(catalog: ExamCatalog): Promise<void> {
	parseCatalog(catalog);
	for (const task of catalog.tasks) {
		if (task.network) continue;
		if (!task.fixture || !existsSync(join(FIXTURE_ROOT, task.fixture))) throw new Error(`fixture missing for ${task.id}`);
	}
}

export async function runExam(opts: { catalog: ExamCatalog; tasks: ExamTask[]; uiBase: string; provider: string; model: string }): Promise<string> {
	await validateCatalogAndFixtures(opts.catalog);
	await preflight({ uiBase: opts.uiBase, model: opts.model });
	const server = await startFixtureServer();
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}${opts.tasks.length === 1 ? "-single" : ""}`;
	const runDir = join(RESULTS_ROOT, runId);
	await mkdir(runDir, { recursive: true });
	const manifest = { runId, startedAt: new Date().toISOString(), complete: false, gitSha: await gitSha(), provider: opts.provider, model: opts.model, tasksJsonSha256: await sha256Path(join(EXAM_ROOT, "tasks.json")), fixturesSha256: await sha256Path(FIXTURE_ROOT), uiBase: opts.uiBase, tasks: opts.tasks.map((task) => task.id), categories: Object.fromEntries(opts.tasks.map((task) => [task.id, task.category])) };
	await writeJson(join(runDir, "manifest.json"), manifest);
	const preamble = await readFile(join(EXAM_ROOT, "prompt-preamble.txt"), "utf8");
	try {
		for (const task of opts.tasks) {
			const outDir = join(runDir, task.id);
			await mkdir(outDir, { recursive: true });
			const started = Date.now();
			let spawned: SpawnResult;
			let status: ExecutionStatus = "COMPLETED";
			try {
				spawned = await spawnHer({ prompt: composePrompt(task, server.baseUrl, outDir, preamble), cwd: outDir, allowTools: opts.catalog.toolPolicy.allow, timeoutMs: task.timeoutMs ?? 300_000, provider: opts.provider, model: opts.model });
				if (spawned.timedOut) status = "TIMEOUT";
				else if (spawned.exitCode !== 0) status = classifyNetworkFailure(task, `${spawned.stderr}\n${spawned.stdout}`);
			} catch (error) {
				spawned = { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
				status = classifyNetworkFailure(task, spawned.stderr);
			}
			await writeFile(join(outDir, "transcript.ndjson"), spawned.stdout, "utf8");
			let result: TaskResult;
			try {
				const calls = parseToolCalls(spawned.stdout);
				if (status === "COMPLETED" && calls.order.length === 0) status = "GRADER_ERROR";
				result = await scoreTask(task, outDir, calls, status, Date.now() - started);
			} catch (error) {
				result = await scoreTask(task, outDir, { counts: {}, order: [] }, "GRADER_ERROR", Date.now() - started);
				result.notes = error instanceof Error ? error.message : String(error);
			}
			await writeResultAtomic(runDir, task.id, result);
		}
		await writeJson(join(runDir, "manifest.json"), { ...manifest, complete: true, completedAt: new Date().toISOString() });
		await writeReport(runDir);
		return runDir;
	} finally {
		await server.close();
	}
}

export async function main(argv = process.argv.slice(2), output: (line: string) => void = console.log): Promise<void> {
	const catalog = await loadTasks(join(EXAM_ROOT, "tasks.json"));
	if (argv[0] === "--list") {
		for (const task of catalog.tasks) output(`${task.id}\t${task.category}\t${task.title}`);
		return;
	}
	if (argv[0] === "--validate") {
		await validateCatalogAndFixtures(catalog);
		output(`validated ${catalog.tasks.length} tasks and fixtures`);
		return;
	}
	const provider = process.env.HER_EXAM_PROVIDER?.trim() || "openai";
	const model = process.env.HER_EXAM_MODEL?.trim() || "gpt-5.6";
	if (argv[0] === "--doctor") {
		await preflight({ model });
		const result = await spawnHer({ prompt: "List every visible tool name, one per line.", cwd: EXAM_ROOT, allowTools: catalog.toolPolicy.allow, timeoutMs: 120_000, provider, model });
		output(result.stdout || result.stderr);
		return;
	}
	const taskIndex = argv.indexOf("--task");
	const tasks = argv[0] === "--all" ? catalog.tasks : taskIndex >= 0 ? catalog.tasks.filter((task) => task.id === argv[taskIndex + 1]) : [];
	if (tasks.length === 0) throw new Error("use --list, --validate, --doctor, --all, or --task <id>");
	if (taskIndex >= 0 && tasks.length !== 1) throw new Error(`unknown task id: ${argv[taskIndex + 1] ?? ""}`);
	const runDir = await runExam({ catalog, tasks, uiBase: resolveUiBase(), provider, model });
	output(runDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
