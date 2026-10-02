/** Small, untrusted wire envelope; no source text, paths, permissions, or completion writes. */
export interface ObserverReport {
	version: 1;
	structuralOnly: true;
	manifestId: string;
	status: "pending" | "blocked" | "evidence-complete";
	checkedAt?: string;
	attempts?: number;
	sources?: number;
}

export interface ReportConnection {
	url: string;
	token: string;
	manifestId: string;
}

export function parseConnection(env: NodeJS.ProcessEnv): ReportConnection | undefined {
	if (env.HER_OBSERVER_REPORT_ENABLED !== "1") return undefined;
	const url = new URL(env.HER_OBSERVER_REPORT_URL ?? "");
	if (
		url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
		url.pathname !== "/her-observer/report" || url.search || url.hash || url.username || url.password
	) throw new Error("observer-loopback-endpoint-required");
	const token = env.HER_OBSERVER_REPORT_TOKEN ?? "";
	const manifestId = env.HER_OBSERVER_REPORT_MANIFEST ?? "";
	if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{64}$/.test(manifestId)) {
		throw new Error("observer-host-binding-required");
	}
	return { url: url.href, token, manifestId };
}

export function parseReport(raw: unknown, manifestId: string, now = Date.now()): ObserverReport {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("observer-report-invalid");
	const value = raw as Record<string, unknown>;
	if (
		value.version !== 1 || value.structuralOnly !== true || value.manifestId !== manifestId ||
		!/^[a-f0-9]{64}$/.test(manifestId) ||
		(value.status !== "pending" && value.status !== "blocked" && value.status !== "evidence-complete")
	) throw new Error("observer-report-invalid");
	const report: ObserverReport = { version: 1, structuralOnly: true, manifestId, status: value.status };
	if (value.status === "evidence-complete") {
		const checked = typeof value.checkedAt === "string" ? Date.parse(value.checkedAt) : Number.NaN;
		if (!Number.isFinite(checked) || checked > now + 5000 || now - checked > 30000) {
			throw new Error("observer-report-stale");
		}
		if (
			typeof value.attempts !== "number" || !Number.isSafeInteger(value.attempts) ||
			value.attempts < 1 || value.attempts > 64 ||
			typeof value.sources !== "number" || !Number.isSafeInteger(value.sources) ||
			value.sources < 1 || value.sources > 16 || value.attempts < value.sources
		) throw new Error("observer-report-invalid");
		report.checkedAt = new Date(checked).toISOString();
		report.attempts = value.attempts;
		report.sources = value.sources;
	}
	return report; // Never forward extra fields, source paths, or instructions from the endpoint.
}

export function reportText(report: ObserverReport): string {
	if (report.status === "evidence-complete") {
		return `观察回执：${report.sources} 项结构证据已在 ${report.checkedAt} 核对。` +
			"这是该时刻的文件摘要与行号核验，不是逻辑正确或任务完成的证明。";
	}
	return report.status === "pending" ? "观察回执：证据尚未齐全，不能据此声称完成。" :
		"观察回执：核验被阻止或证据失效，不能据此声称完成。";
}

export async function fetchReport(
	connection: ReportConnection,
	sessionId: string,
	signal: AbortSignal,
): Promise<ObserverReport> {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("observer-session-invalid");
	// Validate even when a host passes a connection directly rather than through the environment.
	parseConnection({ HER_OBSERVER_REPORT_ENABLED: "1", HER_OBSERVER_REPORT_URL: connection.url,
		HER_OBSERVER_REPORT_TOKEN: connection.token, HER_OBSERVER_REPORT_MANIFEST: connection.manifestId });
	const abort = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
	const response = await fetch(connection.url, {
		method: "GET", redirect: "error", signal: abort,
		headers: { Authorization: `Bearer ${connection.token}`, "X-Her-Session": sessionId,
			"X-Her-Manifest": connection.manifestId, Accept: "application/json" },
	});
	if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
		await response.body?.cancel();
		throw new Error("observer-endpoint-unavailable");
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("observer-report-empty");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			abort.throwIfAborted();
			const part = await reader.read();
			if (part.done) break;
			size += part.value.length;
			if (size > 8192) throw new Error("observer-report-too-large");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
		reader.releaseLock();
	}
	abort.throwIfAborted();
	const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	return parseReport(raw, connection.manifestId);
}
