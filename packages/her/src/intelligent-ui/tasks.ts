const TASK_RESPONSE_MAX_BYTES = 65_536;
const TASK_TIMEOUT_MS = 15_000;

/** Metadata only: task values stay in Studio's immutable, source-backed snapshot. */
export interface IntelligentUiTaskSnapshot {
	ok: true;
	kind: "her-background-tasks";
	version: 1;
	workspaceId: string;
	snapshotId: string;
	capturedAt: string;
	summary: {
		configured: boolean;
		totalFiles: number;
		includedRecords: number;
		excludedRecords: number;
		limited: boolean;
		warnings: string[];
	};
}

interface TaskRequest {
	fetchImpl: typeof fetch;
	uiBase: string;
	workspaceId?: string;
	requestTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readSnapshot(value: unknown, workspaceId: string): IntelligentUiTaskSnapshot {
	const item = record(value);
	const summary = record(item?.summary);
	if (
		!item ||
		item.ok !== true ||
		item.kind !== "her-background-tasks" ||
		item.version !== 1 ||
		item.workspaceId !== workspaceId ||
		typeof item.snapshotId !== "string" ||
		!/^[a-f0-9]{64}$/.test(item.snapshotId) ||
		typeof item.capturedAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.capturedAt) ||
		!Number.isFinite(Date.parse(item.capturedAt)) ||
		new Date(item.capturedAt).toISOString() !== item.capturedAt ||
		!summary ||
		typeof summary.configured !== "boolean" ||
		typeof summary.limited !== "boolean" ||
		!count(summary.totalFiles) ||
		!count(summary.includedRecords) ||
		!count(summary.excludedRecords) ||
		summary.includedRecords > 500 ||
		summary.includedRecords + summary.excludedRecords !== summary.totalFiles ||
		!Array.isArray(summary.warnings) ||
		summary.warnings.length > 100 ||
		!summary.warnings.every((warning): warning is string => typeof warning === "string" && warning.length <= 1_000)
	) {
		throw new Error("Task snapshot has an invalid dataset, workspace, reference or coverage contract");
	}
	if (!summary.configured)
		throw new Error("Task source is not configured. Set HER_MEMORY_DIR in Studio before requesting tasks.");
	return {
		ok: true,
		kind: "her-background-tasks",
		version: 1,
		workspaceId,
		snapshotId: item.snapshotId,
		capturedAt: item.capturedAt,
		summary: {
			configured: summary.configured,
			totalFiles: summary.totalFiles,
			includedRecords: summary.includedRecords,
			excludedRecords: summary.excludedRecords,
			limited: summary.limited,
			warnings: [...summary.warnings],
		},
	};
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
	if (Number(response.headers.get("content-length")) > TASK_RESPONSE_MAX_BYTES) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`Task snapshot response exceeds ${TASK_RESPONSE_MAX_BYTES} bytes`);
	}
	if (!response.body) throw new Error("Task snapshot response is empty");
	const reader = response.body.getReader();
	const cancel = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		signal.throwIfAborted();
		while (true) {
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > TASK_RESPONSE_MAX_BYTES)
				throw new Error(`Task snapshot response exceeds ${TASK_RESPONSE_MAX_BYTES} bytes`);
			chunks.push(chunk.value);
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw new Error("Task snapshot returned invalid UTF-8 or JSON");
	}
}

/** No model-provided destination, file path, rows, computation or executable source. */
export async function requestIntelligentUiTasks(
	request: TaskRequest,
	signal?: AbortSignal,
): Promise<IntelligentUiTaskSnapshot> {
	const workspaceId = (request.workspaceId ?? process.env.HER_WORKSPACE_ID)?.trim();
	if (!workspaceId || workspaceId.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
		throw new Error(
			"Tasks require the current Studio workspace (HER_WORKSPACE_ID); Pi session ids are not workspace ids",
		);
	}
	const timeout = AbortSignal.timeout(request.requestTimeoutMs ?? TASK_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	requestSignal.throwIfAborted();
	const base = request.uiBase.replace(/\/+$/, "");
	let response: Response;
	try {
		response = await request.fetchImpl(`${base}/api/conversations/${workspaceId}/task-insights`, {
			method: "POST",
			redirect: "error",
			signal: requestSignal,
		});
	} catch (error) {
		throw new Error(`Task snapshot request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	requestSignal.throwIfAborted();
	if (!response.ok) {
		void response.body?.cancel().catch(() => {});
		throw new Error(`Task snapshot request failed (HTTP ${response.status})`);
	}
	const metadata = readSnapshot(await readBoundedJson(response, requestSignal), workspaceId);
	requestSignal.throwIfAborted();
	return metadata;
}
