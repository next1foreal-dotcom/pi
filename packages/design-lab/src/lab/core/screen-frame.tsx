import { memo, type ReactNode } from "react";
import { ScreenProvider, type ScreenState } from "../screen-context";
import type { ScreenLayout } from "./types";
import styles from "./lab.module.css";

const EDGES = ["n", "s", "e", "w", "nw", "ne", "sw", "se"] as const;
export type ResizeEdge = (typeof EDGES)[number];

type Props = {
  id: string;
  layout: ScreenLayout;
  selected: boolean;
  active: boolean;
  dimmed: boolean;
  showHandles: boolean;
  env: ScreenState;
  children: ReactNode;
  onShieldPointerDown: (e: React.PointerEvent, id: string) => void;
  onShieldDoubleClick: (id: string) => void;
  onResizePointerDown: (
    e: React.PointerEvent,
    id: string,
    edge: ResizeEdge,
  ) => void;
};

function ScreenFrameInner({
  id,
  layout,
  selected,
  active,
  dimmed,
  showHandles,
  env,
  children,
  onShieldPointerDown,
  onShieldDoubleClick,
  onResizePointerDown,
}: Props) {
  return (
    <div
      className={styles.group}
      data-screen-id={id}
      data-active={active ? "" : undefined}
      style={{
        width: layout.width,
        height: layout.height,
        transform: `translate(${layout.x}px, ${layout.y}px)`,
      }}
    >
      <div className={styles.frame}>
        <div className={styles.scroll} data-screen-scroll={id} tabIndex={-1}>
          <ScreenProvider value={env}>
            <div className={styles.content}>{children}</div>
          </ScreenProvider>
        </div>
        <div
          className={styles.shield}
          onPointerDown={(e) => onShieldPointerDown(e, id)}
          onDoubleClick={() => onShieldDoubleClick(id)}
        />
        {dimmed ? <div className={styles.dim} /> : null}
        {selected || active ? <div className={styles.ring} /> : null}
      </div>
      {showHandles
        ? EDGES.map((edge) => (
            <div
              key={edge}
              className={styles.handle}
              data-edge={edge}
              onPointerDown={(e) => onResizePointerDown(e, id, edge)}
            />
          ))
        : null}
    </div>
  );
}

export const ScreenFrame = memo(ScreenFrameInner);
