import type { TaskPrivacy } from "./task-context-snapshot.ts";

export type PrivacyBoundary = "external" | "local";

export type TaskRouteDecision = {
	version: "task-route-v1";
	worker: string;
	model: string;
	privacy: TaskPrivacy;
	privacyBoundary: PrivacyBoundary;
	cacheAffinity: "cold" | "warm";
	contextSnapshotTokens: number;
	contextReloadTokens: number;
	allowed: boolean;
	reasons: string[];
};

export function evaluateTaskRoute(input: {
	worker: string;
	model: string;
	privacy: TaskPrivacy;
	privacyBoundary?: PrivacyBoundary;
	contextSnapshotTokens: number;
	parentWorker?: string;
	reuseWorktree?: boolean;
}): TaskRouteDecision {
	const privacyBoundary = input.privacyBoundary ?? "external";
	const cacheAffinity = input.reuseWorktree || input.parentWorker === input.worker ? "warm" : "cold";
	const allowed = input.privacy === "public" || privacyBoundary === "local";
	const contextReloadTokens =
		cacheAffinity === "warm" ? Math.ceil(input.contextSnapshotTokens / 4) : input.contextSnapshotTokens;
	return {
		version: "task-route-v1",
		worker: input.worker,
		model: input.model,
		privacy: input.privacy,
		privacyBoundary,
		cacheAffinity,
		contextSnapshotTokens: input.contextSnapshotTokens,
		contextReloadTokens,
		allowed,
		reasons: [
			cacheAffinity === "warm" ? "cache-affinity" : "context-reload",
			allowed ? "privacy-boundary-ok" : "privacy-boundary-deny",
		],
	};
}
