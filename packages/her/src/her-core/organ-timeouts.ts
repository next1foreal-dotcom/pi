export const ORGAN_MODEL_TIMEOUT_MS = {
	consolidate: 900 * 1000,
	reflect: 600 * 1000,
	synthesize: 900 * 1000,
	"topic-maps": 1200 * 1000,
	ideas: 600 * 1000,
} as const;

export type OrganModelTimeoutName = keyof typeof ORGAN_MODEL_TIMEOUT_MS;

export function organTimeoutError(organ: string, timeoutMs: number, elapsedMs: number): string {
	return `${organ} timed out after ${elapsedMs}ms (limit ${timeoutMs}ms)`;
}

export async function withModelTimeout<T>(
	organ: string,
	timeoutMs: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const call = work(controller.signal);
	void call.catch(() => {});
	try {
		return await Promise.race([call, timeoutRejection(organ, timeoutMs, started, controller.signal)]);
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(organTimeoutError(organ, timeoutMs, Date.now() - started));
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function timeoutRejection(organ: string, timeoutMs: number, started: number, signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		const fail = () => reject(new Error(organTimeoutError(organ, timeoutMs, Date.now() - started)));
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
	});
}
