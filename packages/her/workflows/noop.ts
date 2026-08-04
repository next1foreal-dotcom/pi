/**
 * G-145 smoke — phases only, no Agent. Safe for CI / bg-task bridge checks.
 */

import { phase } from "../../../../../deer-workflow/src/flow/index.ts";
import { log } from "../../../../../deer-workflow/src/logging/index.ts";

export const meta = {
	name: "her-noop",
	description: "Emits phases without calling an Agent.",
	phases: [{ title: "Alpha" }, { title: "Beta" }],
	exampleArgs: { note: "bridge-smoke" },
};

export default async function noop(args: { note?: string }) {
	phase("Alpha");
	log(`note: ${args.note ?? "ok"}`);
	phase("Beta");
	log("done");
	return { ok: true, note: args.note ?? "ok" };
}
