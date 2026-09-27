import { useSyncExternalStore } from "react";
import { chipBox, placeHand } from "./place";
import { getHand, subscribeHand } from "./store";
import styles from "./overlay.module.css";

export function HandOverlay() {
	const snap = useSyncExternalStore(subscribeHand, getHand, getHand);
	if (!snap) return null;
	const placed = placeHand(snap.rect, chipBox(snap.label));
	return (
		<div
			className={styles.root}
			data-lab-hand=""
			style={{
				transform: `translate(${placed.cursor.x}px, ${placed.cursor.y}px) scale(var(--inv-zoom, 1))`,
			}}
		>
			<svg
				className={styles.cursor}
				width="18"
				height="18"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<path
					d="M4 3 L4 19 L9.2 14.2 L13.2 22.1 L16.1 20.9 L12.2 13.1 L20 13 Z"
					fill="#f1f1f1"
					stroke="#1c1c1c"
					strokeWidth="1.25"
					strokeLinejoin="round"
				/>
			</svg>
			<div
				className={styles.chip}
				data-lab-hand-chip=""
				style={{
					transform: `translate(${placed.chip.x - placed.cursor.x}px, ${placed.chip.y - placed.cursor.y}px)`,
				}}
			>
				{snap.label}
			</div>
		</div>
	);
}
