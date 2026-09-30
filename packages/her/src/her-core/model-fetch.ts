import { setTimeout as delay } from "node:timers/promises";

/** Only retry failed connection establishment: response/socket failures may already be billed. */
export async function fetchModel(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
	// Fail closed on redirects: a target connect timeout must not replay a sent POST.
	const request = { ...init, redirect: "error" as const };
	for (let attempt = 0; ; attempt++) {
		init.signal?.throwIfAborted();
		try {
			return await fetcher(url, request);
		} catch (error) {
			init.signal?.throwIfAborted();
			const cause = error instanceof Error ? error.cause : undefined;
			if (
				attempt >= 2 ||
				!cause ||
				typeof cause !== "object" ||
				!("code" in cause) ||
				cause.code !== "UND_ERR_CONNECT_TIMEOUT"
			)
				throw error;
			console.warn(`[her] model connection timed out before sending; retry ${attempt + 1}/2`);
			await delay(500 * (attempt + 1), undefined, { signal: init.signal ?? undefined });
		}
	}
}
