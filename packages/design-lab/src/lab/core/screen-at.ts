import type { Point, Rect } from "./types";

/**
 * First screen whose layout rectangle contains `point` (page space).
 * Inclusive on the origin edge, exclusive on the far edge.
 */
export function screenAt(
	point: Point,
	screens: readonly { id: string }[],
	layouts: Record<string, Rect | undefined>,
): string | null {
	for (const s of screens) {
		const r = layouts[s.id];
		if (!r) continue;
		if (
			point.x >= r.x &&
			point.x < r.x + r.width &&
			point.y >= r.y &&
			point.y < r.y + r.height
		) {
			return s.id;
		}
	}
	return null;
}
