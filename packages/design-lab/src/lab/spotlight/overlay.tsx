import { useSyncExternalStore } from "react";
import {
  getSpotlightOverlay,
  subscribeSpotlightOverlay,
} from "./overlay-store";
import styles from "./overlay.module.css";

export function SpotlightOverlay() {
  const s = useSyncExternalStore(
    subscribeSpotlightOverlay,
    getSpotlightOverlay,
    getSpotlightOverlay,
  );
  const r = s.rect ?? s.lastRect;
  if (!r) return null;
  return (
    <div
      className={styles.box}
      data-spotlight-overlay=""
      data-show={s.rect ? "" : undefined}
      data-fast={s.fast ? "" : undefined}
      style={{
        transform: `translate(${r.x}px, ${r.y}px)`,
        width: r.width,
        height: r.height,
      }}
    />
  );
}
