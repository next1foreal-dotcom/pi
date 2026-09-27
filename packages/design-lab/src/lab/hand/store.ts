import type { Rect } from "../core/types";
import { nodeRect, pickWorkMark, type WorkMark } from "./place";
import { type WorkAt, workKey } from "./work";

export type { WorkMark };

export type HandSnap = {
	rect: Rect;
	label: string;
};

let snap: HandSnap | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

export function getHand(): HandSnap | null {
	return snap;
}

export function subscribeHand(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function setHand(next: HandSnap | null): void {
	snap = next;
	emit();
}

export function hideHand(): void {
	setHand(null);
}

export function pinHandFromWork(rects: readonly Rect[], label: string): void {
	const rect = nodeRect(rects);
	if (!rect) return;
	setHand({ rect, label });
}

/**
 * Pin to the node she wrote on the screen he is watching. A neighbour-only
 * batch, or a remount that does not include that node, leaves the current hand.
 */
export function pinHandOnWatched(
	items: readonly WorkMark[],
	watchedId: string | null,
	work: WorkAt | null = null,
): void {
	const hit = pickWorkMark(items, watchedId, work);
	if (!hit) return;
	const owned = work !== null && (hit.keys ?? []).includes(workKey(work));
	setHand({
		rect: hit.rect,
		label: owned && work ? work.label : hit.label,
	});
}
