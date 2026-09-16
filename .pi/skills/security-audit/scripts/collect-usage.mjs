/**
 * Per-subagent usage for the run ledger.
 *
 * pi-subagents drops usage on the floor between the child and the text the
 * parent model sees: the aggregated result is `N/N succeeded` plus each child's
 * output, and nothing else. The numbers do survive on disk — one meta file per
 * child under the session's subagent-artifacts directory — so agents_spent is
 * built by reading that directory, never by parsing the tool result.
 *
 * Patching node_modules to add the line was considered and rejected: the next
 * install erases it, and a run ledger that silently loses its cost column is
 * worse than one that never had it.
 *
 * Usage: node collect-usage.mjs <project-cwd> [--since <epoch-ms>] [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * pi slugs a project path into its sessions directory name. Derived from the
 * observed layout rather than guessed: `D:\@Her\Her-repo\samantha` becomes
 * `--D--@Her-Her-repo-samantha--`.
 */
export function sessionSlug(projectPath) {
	// Every character outside [A-Za-z0-9] becomes one "-", then the whole thing
	// is wrapped in "--". Read off the real directory names rather than reasoned
	// about: `C:\Users\Admin` is `--C--Users-Admin--`, which only holds if the
	// colon AND the separator each contribute their own dash. Stripping the
	// colon instead yields `--C-Users-Admin--` — a path that does not exist,
	// and the collector then reports "no artifacts dir" for a run that has 26
	// meta files sitting on disk.
	const body = projectPath.replace(/[^A-Za-z0-9@._-]/g, "-");
	return `--${body}--`;
}

export function artifactsDir(projectPath, home = homedir()) {
	return join(home, ".pi", "agent", "sessions", sessionSlug(projectPath), "subagent-artifacts");
}

/**
 * Read every child's meta record. `since` filters by file mtime so one run's
 * accounting does not absorb an earlier run's children — the meta files
 * accumulate in one directory across runs and carry no run boundary of their
 * own beyond runId, which the parent does not know until after the call.
 */
export function collectUsage(projectPath, { since = 0, home = homedir() } = {}) {
	const dir = artifactsDir(projectPath, home);
	let entries;
	try {
		entries = readdirSync(dir);
	} catch (error) {
		return { dir, available: false, reason: String(error.message ?? error), records: [] };
	}

	const records = [];
	for (const name of entries) {
		if (!name.endsWith("_meta.json")) continue;
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.mtimeMs < since) continue;
		try {
			const meta = JSON.parse(readFileSync(full, "utf8"));
			records.push({
				file: name,
				runId: meta.runId,
				agent: meta.agent,
				exitCode: meta.exitCode,
				model: meta.model,
				durationMs: meta.durationMs,
				toolCount: meta.toolCount,
				usage: meta.usage ?? null,
				task: typeof meta.task === "string" ? meta.task.slice(0, 200) : undefined,
			});
		} catch {
			// A half-written meta file is a gap in the ledger, not a reason to
			// lose the rest of the run's accounting.
			records.push({ file: name, unreadable: true });
		}
	}

	const usable = records.filter((r) => r.usage);
	const totals = usable.reduce(
		(acc, r) => ({
			input: acc.input + (r.usage.input ?? 0),
			output: acc.output + (r.usage.output ?? 0),
			cacheRead: acc.cacheRead + (r.usage.cacheRead ?? 0),
			cacheWrite: acc.cacheWrite + (r.usage.cacheWrite ?? 0),
			cost: acc.cost + (r.usage.cost ?? 0),
			turns: acc.turns + (r.usage.turns ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
	);

	return {
		dir,
		available: true,
		agents: records.length,
		withUsage: usable.length,
		unreadable: records.filter((r) => r.unreadable).length,
		totals,
		records,
	};
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
	const [, , projectPath, ...rest] = process.argv;
	if (!projectPath) {
		console.error("usage: node collect-usage.mjs <project-cwd> [--since <epoch-ms>] [--json]");
		process.exit(2);
	}
	const sinceIndex = rest.indexOf("--since");
	const since = sinceIndex >= 0 ? Number(rest[sinceIndex + 1]) : 0;
	const result = collectUsage(projectPath, { since });

	if (rest.includes("--json")) {
		console.log(JSON.stringify(result, null, 2));
	} else if (!result.available) {
		console.log(`no artifacts dir: ${result.dir}`);
		console.log(`reason: ${result.reason}`);
	} else {
		console.log(`dir: ${result.dir}`);
		console.log(`agents: ${result.agents}  with usage: ${result.withUsage}  unreadable: ${result.unreadable}`);
		const t = result.totals;
		console.log(
			`totals: ↑${t.input} ↓${t.output} R${t.cacheRead} W${t.cacheWrite} $${t.cost.toFixed(4)} ${t.turns} turns`,
		);
	}
}
