import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchReport, type ObserverReport, parseConnection, reportText } from "./protocol.ts";

/** Explicit report retrieval only. No SDK import, timers, tools, permissions or model requests. */
export default function observerReport(pi: ExtensionAPI): void {
	const connection = parseConnection(process.env);
	if (!connection) return;
	let active: AbortController | undefined;
	let epoch = 0;
	let cached: ObserverReport | undefined;
	const clear = (_event: unknown, ctx: ExtensionContext): void => {
		epoch++;
		active?.abort();
		active = undefined;
		cached = undefined;
		try { if (ctx.hasUI) ctx.ui.setStatus("her-observer", undefined); } catch { /* Disconnected UI. */ }
	};
	pi.on("session_start", clear);
	pi.on("session_switch", clear);
	pi.on("session_shutdown", clear);
	pi.on("session_tree", clear);
	pi.registerCommand("her-observer", {
		description: "Read a host-bound Durable observation report: refresh, status or clear. Never starts work.",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "clear") { clear(undefined, ctx); return; }
			if (action !== "status" && action !== "refresh") throw new Error("use /her-observer refresh|status|clear");
			if (action === "status") {
				pi.sendMessage({ customType: "her-observer-report", display: true,
					content: cached ? `历史快照（不会自动刷新）：${reportText(cached)}` :
						`当前会话 ${ctx.sessionManager.getSessionId()} 尚无观察回执；使用 refresh 显式核对。`,
					details: { cached: true, report: cached ?? null } });
				return;
			}
			if (active) throw new Error("observer-refresh-already-running");
			const sessionId = ctx.sessionManager.getSessionId();
			const generation = ++epoch;
			const controller = new AbortController();
			active = controller;
			const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
			const isCurrent = (): boolean => {
				if (signal.aborted || generation !== epoch) return false;
				try { return ctx.sessionManager.getSessionId() === sessionId; } catch { return false; }
			};
			cached = undefined; // An old pass must not survive a failed refresh.
			try {
				try { if (ctx.hasUI) ctx.ui.setStatus("her-observer", "正在核对观察回执"); } catch { /* UI only. */ }
				const report = await fetchReport(connection, sessionId, signal);
				if (!isCurrent()) return;
				pi.appendEntry("her-observer-report-v1", { sessionId, report });
				pi.sendMessage({ customType: "her-observer-report", content: reportText(report), display: true,
					details: { sessionId, report } }, { deliverAs: "followUp" });
				cached = report;
				try { if (ctx.hasUI) ctx.ui.setStatus("her-observer", "观察快照已记录；不会自动刷新"); } catch { /* UI only. */ }
			} catch {
				if (!isCurrent()) return;
				cached = undefined;
				try { if (ctx.hasUI) ctx.ui.setStatus("her-observer", "观察核验不可用"); } catch { /* UI only. */ }
				pi.sendMessage({ customType: "her-observer-report", display: true,
					content: "观察回执未通过本次核对，旧快照不可作为当前证明。未启动或恢复任何任务。",
					details: { sessionId, unavailable: true } }, { deliverAs: "followUp" });
			} finally {
				if (active === controller) active = undefined;
			}
		},
	});
}
