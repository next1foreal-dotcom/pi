import { captureCheckpoint, listCheckpoints, restoreCheckpoint } from "./her-core/checkpoint.ts";

function value(flag: string): string {
	const index = process.argv.indexOf(flag);
	const found = index >= 0 ? process.argv[index + 1]?.trim() : "";
	if (!found) throw new Error(`missing ${flag}`);
	return found;
}

export function main(): void {
	const command = process.argv[2];
	const memoryRoot = value("--memory-root");
	const repoRoot = value("--repo-root");
	if (command === "capture") {
		const sessionId = process.argv.includes("--session-id") ? value("--session-id") : undefined;
		const label = process.argv.includes("--label") ? value("--label") : undefined;
		process.stdout.write(
			`${JSON.stringify({ ok: true, ...captureCheckpoint(memoryRoot, repoRoot, { sessionId, label }) })}\n`,
		);
		return;
	}
	if (command === "list") {
		const sessionId = process.argv.includes("--session-id") ? value("--session-id") : "";
		const rows = listCheckpoints(memoryRoot, repoRoot, 100).filter(
			(row) => !sessionId || row.sessionId === sessionId,
		);
		process.stdout.write(`${JSON.stringify({ ok: true, checkpoints: rows })}\n`);
		return;
	}
	if (command === "restore") {
		const report = restoreCheckpoint(memoryRoot, repoRoot, value("--id"));
		process.stdout.write(`${JSON.stringify({ ok: report.skipped.length === 0, ...report })}\n`);
		return;
	}
	throw new Error("usage: checkpoint-cli.ts capture|list|restore --memory-root <path> --repo-root <path>");
}

try {
	main();
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
