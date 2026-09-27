import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClient } from "../../src/experimental/client.ts";
import { startServer } from "../../src/experimental/server.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "../experimental-session-support.ts";

const agentDir = await mkdtemp(join(tmpdir(), "pi-windows-agent-"));
const directory = await mkdtemp(join(tmpdir(), "pi-windows-server-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SERVER_DIR = directory;
process.env.PI_SERVER_ID = "00000000-0000-4000-8000-000000000001";

try {
	await configureExperimentalWorkerModel(agentDir);
	await createExperimentalSessions(join(agentDir, "experimental", "sessions"), ["demo-1"]);
	const runtime = await startServer({ provider: "anthropic", model: "claude-sonnet-4-5", directory });
	try {
		console.log(`socket=${runtime.socketPath}`);
		console.log(`result=${JSON.stringify(await runClient({ command: "client" }))}`);
	} finally {
		await runtime.close();
	}
} finally {
	await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(directory, { recursive: true, force: true })]);
}
