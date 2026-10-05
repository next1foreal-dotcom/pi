import { isAbsolute } from "node:path";
import { runtimeContractHash } from "./runtime-contract.ts";
import { smokeRuntime } from "./runtime-smoke.ts";
import { readRuntimeState, resolveManagedRuntime } from "./runtime-state.ts";
import { activateRuntime, checkRuntimeUpdate, stageRuntime, verifyRuntime } from "./runtime-update.ts";

// node --import tsx packages/her/src/hands/runtime-cli.ts <command> <absolute-root> [version/id/binary]
const [command, root, argument, flag] = process.argv.slice(2);
try {
	if (!root || !isAbsolute(root))
		throw new Error(
			"Usage: <status|check|stage|verify|activate|rollback> <absolute-root> [version/id/bootstrap-binary] [--allow-fixture]",
		);
	let result: unknown;
	switch (command) {
		case "status":
			result = readRuntimeState(root);
			break;
		case "check":
			result = await checkRuntimeUpdate(
				root,
				argument ?? resolveManagedRuntime(`managed:${root}`, runtimeContractHash),
				true,
			);
			break;
		case "stage": {
			const version = argument ?? String(readRuntimeState(root).update?.latest_version ?? "");
			result = await stageRuntime(root, version);
			break;
		}
		case "verify":
			if (!argument || flag !== "--allow-fixture")
				throw new Error(
					"verify requires a candidate ID and --allow-fixture (launches an isolated browser and acts only on a loopback fixture)",
				);
			result = await verifyRuntime(root, argument, smokeRuntime);
			break;
		case "activate":
			if (!argument) throw new Error("activate requires a candidate ID");
			result = await activateRuntime(root, argument);
			break;
		case "rollback":
			result = await activateRuntime(root);
			break;
		default:
			throw new Error("Unknown CUA management command");
	}
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
