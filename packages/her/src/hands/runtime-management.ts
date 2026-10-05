import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HandsDriver } from "./driver.ts";
import { CuaMcpDriver } from "./mcp-driver.ts";
import { smokeRuntime } from "./runtime-smoke.ts";
import { readRuntimeState } from "./runtime-state.ts";
import { activateRuntime, checkRuntimeUpdate, stageRuntime, verifyRuntime } from "./runtime-update.ts";

/** Human command only. Never expose installation/activation as an agent tool. */
export function registerCuaManagement(pi: ExtensionAPI, driver: HandsDriver): void {
	if (!(driver instanceof CuaMcpDriver) || !driver.managementRoot) return;
	const root = driver.managementRoot;
	pi.registerCommand("cua", {
		description: "CUA stable updates: status | check | stage <version> | verify <id> | activate <id> | rollback",
		handler: async (args, ctx) => {
			try {
				const [command = "status", argument] = args.trim().split(/\s+/);
				let result: unknown;
				switch (command) {
					case "status":
						result = { runningBinary: driver.binary, nextStart: readRuntimeState(root) };
						break;
					case "check":
						result = await checkRuntimeUpdate(root, driver.binary, true);
						break;
					case "stage":
						result = await stageRuntime(
							root,
							argument ?? String(readRuntimeState(root).update?.latest_version ?? ""),
						);
						break;
					case "verify":
						if (!argument) throw new Error("verify requires a candidate ID");
						if (!ctx.hasUI || !ctx.isIdle())
							throw new Error("Verification requires an idle interactive Her session");
						if (
							!(await ctx.ui.confirm(
								"Samantha requests computer control: CUA update verification",
								"Launch an isolated browser and test window observation, typing, clicks, upload and download against a local fixture. No existing browser profile is attached.",
							))
						)
							return;
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
						throw new Error("Use /cua status|check|stage <version>|verify <id>|activate <id>|rollback");
				}
				ctx.ui.notify(JSON.stringify(result, null, 2), "info");
			} catch (error) {
				ctx.ui.notify(`CUA: ${String(error)}`, "error");
			}
		},
	});
	pi.on("session_start", (_event, ctx) => {
		void (async () => {
			// Read-only, once per day while Her is used. No background installation or scheduled task.
			try {
				const update = await checkRuntimeUpdate(root, driver.binary);
				if (update.update_available)
					ctx.ui.notify(
						`CUA stable ${String(update.latest_version)} is available. Use /cua check, then stage and verify before activation.`,
						"info",
					);
			} catch (error) {
				ctx.ui.notify(`CUA update check failed: ${String(error)}`, "warning");
			}
		})();
	});
}
