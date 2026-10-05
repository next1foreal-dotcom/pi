import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../her-core/config.ts";
import { readProtectedFile, sha256 } from "../her-core/improvement-plan.ts";
import { OpenAICompatibleModel } from "../her-core/model.ts";
import { HerGrowthHost } from "./host.ts";
import { recallGrowthMethods } from "./journal.ts";
import { advance, reopen, startInquiry, tryMethod } from "./loop.ts";
import { experiences } from "./parse.ts";
import { runGrowthPilot } from "./pilot.ts";
import { runGrowthTask } from "./task.ts";

/** Opt-in host entry point. No production schedule or tool permission is registered. */
export async function runGrowthCli(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
	cwd = process.cwd(),
): Promise<unknown> {
	const [action, rootArg, planPath, argument, extra] = argv;
	if (!action || !rootArg || !planPath)
		throw new Error(
			"growth: <init|step|status|pilot|task|use|wake|recall|probe-model> <memoryRoot> <hostPlan-relative-path> [experience-file|task-id] [expectation]",
		);
	const root = resolve(cwd, rootArg);
	const model = new OpenAICompatibleModel(loadConfig(resolve(root, ".her/config.yaml")), env);
	const host = await HerGrowthHost.open(root, planPath, cwd, model);
	if (action === "probe-model") {
		const authorization = argument
			? JSON.parse((await readProtectedFile(root, argument, 16384)).toString("utf8"))
			: undefined;
		return host.probeModel(undefined, authorization);
	}
	if (action === "recall")
		return (await recallGrowthMethods(root)).map((s) => ({ inquiryId: s.id, method: s.method }));
	if (host.plan.pilot && !["pilot", "status", "recall"].includes(action))
		throw new Error("owner pilot permission authorizes only the continuous runner; no probe or manual replay");
	if (action === "pilot") {
		if (!host.plan.pilot?.experience || !host.plan.pilotAuthorization || argument || extra)
			throw new Error("pilot needs its frozen owner authorization and experience; no input overrides");
		if (await host.journal.state()) throw new Error("pilot already initialized; no automatic resume or replay");
		const input = experiences(
			JSON.parse((await readProtectedFile(root, host.plan.pilot.experience.file, 1024 * 1024)).toString("utf8")),
		);
		await host.save(
			startInquiry(host.plan.inquiryId, input, {
				thoughts: host.plan.pilot.thoughts,
				probes: host.plan.pilot.probes,
			}),
			-1,
		);
		return runGrowthPilot(host);
	}
	if (action === "init") {
		if (!argument) throw new Error("growth init needs actual experience file");
		const input = experiences(JSON.parse(await readFile(argument, "utf8")));
		for (const e of input.flatMap((item) => item.evidence))
			if (sha256(await readProtectedFile(root, e.ref, 1024 * 1024)) !== e.digest)
				throw new Error("initial experience artifact mismatch");
		const state = startInquiry(host.plan.inquiryId, input, { thoughts: 12, probes: 3 });
		await host.save(state, -1);
		return state;
	}
	const state = await host.journal.state();
	if (!state) throw new Error("initialize revision zero first");
	if (action === "status")
		return {
			state,
			receipts: (await host.journal.read()).map((r) => ({ seq: r.seq, kind: r.kind, digest: r.digest })),
		};
	if (action === "step") return advance(state, host);
	if (action === "task") {
		if (!argument) throw new Error("growth task needs an approved task id");
		return runGrowthTask(host, argument);
	}
	if (action === "use") {
		const task = host.plan.tasks.find((t) => t.id === argument);
		if (!task) throw new Error("new task not in approved host plan");
		const recalled = (await recallGrowthMethods(root)).find((s) => s.id === host.plan.inquiryId);
		if (!recalled) return { status: "no-active-method", taskId: task.id };
		return tryMethod(recalled, { id: task.id, description: task.description, environment: task.environment }, host);
	}
	if (action === "wake") {
		if (!argument || !extra) throw new Error("wake requires completed task id and its original expectation");
		const fresh = await host.taskExperience(argument, extra);
		const reopened = await reopen(state, [fresh], host);
		await host.journal.append("task-wake", { taskId: argument, revision: reopened.revision });
		return reopened;
	}
	throw new Error("unknown growth command");
}
export function growthExitCode(result: unknown): number {
	if (["probe-failed", "task-failed", "INCOMPLETE"].includes((result as { status?: string } | null)?.status ?? ""))
		return 1;
	const phase = (result as { phase?: string } | null)?.phase;
	return phase === "blocked" || phase?.startsWith("pending-") ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	runGrowthCli(process.argv.slice(2)).then(
		(result) => {
			console.log(JSON.stringify(result, null, 2));
			process.exitCode = growthExitCode(result);
		},
		(error) => {
			console.error(error instanceof Error ? error.message : "growth host failed");
			process.exitCode = 1;
		},
	);
}
