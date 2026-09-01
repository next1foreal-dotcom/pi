/**
 * Tell her, at the top of a session, which of her external services are not
 * working — the way Claude Code tells me.
 *
 * Without this, a server that stopped answering is silent: the tools simply
 * are not there, and she has no way to distinguish "this server has nothing
 * for me" from "this server is down". A configured-but-broken connector
 * should be visible, not inferred.
 *
 * Three things are worth saying, and nothing else:
 *  - it is configured but could not be reached
 *  - it is configured but its credential is unset
 *  - it is ready but its tools were never discovered, so they are not
 *    registered — which is the honest cost of the tool cache
 */
import type { LoadedConnector, ReadyConnector } from "./tools.ts";

export interface ConnectorFault {
	slug: string;
	label: string;
	reason: string;
}

export interface StartupReport {
	unreachable: ConnectorFault[];
	missingCredentials: ConnectorFault[];
	undiscovered: ConnectorFault[];
}

export const EMPTY_REPORT: StartupReport = {
	unreachable: [],
	missingCredentials: [],
	undiscovered: [],
};

export function isEmptyReport(report: StartupReport): boolean {
	return report.unreachable.length === 0 && report.missingCredentials.length === 0 && report.undiscovered.length === 0;
}

/**
 * Build the report from what loading found, what probing found, and what the
 * cache holds. Pure, so the wording is testable without a network.
 */
export function buildReport(
	connectors: LoadedConnector[],
	probeFailures: Map<string, string>,
	cachedSlugs: Set<string>,
): StartupReport {
	const report: StartupReport = { unreachable: [], missingCredentials: [], undiscovered: [] };
	for (const connector of connectors) {
		if (connector.status === "missing_credentials") {
			report.missingCredentials.push({
				slug: connector.slug,
				label: connector.label,
				reason: connector.reason,
			});
			continue;
		}
		if (connector.status !== "ready") continue;

		const failure = probeFailures.get(connector.slug);
		if (failure) {
			report.unreachable.push({ slug: connector.slug, label: connector.label, reason: failure });
			continue;
		}
		if (!cachedSlugs.has(connector.slug)) {
			report.undiscovered.push({
				slug: connector.slug,
				label: connector.label,
				reason: "还没发现过它的工具",
			});
		}
	}
	return report;
}

/**
 * The note she actually sees. Returns null when there is nothing wrong —
 * a report that speaks every session teaches her to ignore it.
 */
export function renderReport(report: StartupReport): string | null {
	if (isEmptyReport(report)) return null;
	const lines: string[] = ["[外接服务状态]"];
	for (const fault of report.unreachable) {
		lines.push(`- ${fault.slug}（${fault.label}）连不上：${fault.reason}`);
	}
	for (const fault of report.missingCredentials) {
		lines.push(`- ${fault.slug}（${fault.label}）：${fault.reason}`);
	}
	for (const fault of report.undiscovered) {
		lines.push(
			`- ${fault.slug}（${fault.label}）连得上，但${fault.reason}，所以它的工具还没出现在工具列表里。跑 her_mcp_refresh 再重启即可。`,
		);
	}
	lines.push("这条只在有问题时出现，是配置或连接的问题，不是你做错了什么。");
	return lines.join("\n");
}

/** Probe one connector, returning its failure reason or null when it answers. */
export type ProbeOne = (connector: ReadyConnector) => Promise<string | null>;

/**
 * Probe every ready connector in parallel, bounded.
 *
 * Never throws and never rejects: a startup report that can break startup is
 * worse than no report.
 */
export async function probeAll(connectors: LoadedConnector[], probe: ProbeOne): Promise<Map<string, string>> {
	const ready = connectors.filter((entry): entry is ReadyConnector => entry.status === "ready");
	const failures = new Map<string, string>();
	await Promise.all(
		ready.map(async (connector) => {
			try {
				const reason = await probe(connector);
				if (reason) failures.set(connector.slug, reason);
			} catch (error) {
				failures.set(connector.slug, error instanceof Error ? error.message : String(error));
			}
		}),
	);
	return failures;
}
