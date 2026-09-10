import { memo, type ReactNode } from "react";
import { ScreenProvider, type ScreenState } from "../screen-context";
import type { ResizeEdge, ScreenLayout } from "./types";
import styles from "./lab.module.css";

export type { ResizeEdge };

const EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "nw", "ne", "sw", "se"];

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
            {/*
              The lab's own wrapper, marked so a tool can tell it apart from the
              design. It carries the frame's size and nothing of the page; a
              layers tree that showed it would put one row of plumbing at the
              top of every screen before the first thing anyone drew.
            */}
            <div className={styles.content} data-screen-content>
              {children}
            </div>
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
