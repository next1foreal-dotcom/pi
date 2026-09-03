import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useScreen } from "../../lab/screen-context";

type NodeKind = "frame" | "rect" | "text";
type Corner = "nw" | "ne" | "sw" | "se";

type CanvasNode = {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
};

type Camera = { x: number; y: number; z: number };

type Drag =
  | { kind: "pan"; lx: number; ly: number }
  | {
      kind: "move";
      id: string;
      extras: { id: string; ox: number; oy: number }[];
      lx: number;
      ly: number;
      ox: number;
      oy: number;
    }
  | {
      kind: "resize";
      id: string;
      corner: Corner;
      start: CanvasNode;
      ox: number;
      oy: number;
    }
  | { kind: "pending"; x: number; y: number };

const Z_MIN = 0.25;
const Z_MAX = 3;
const DRAG_SLOP = 4;
const MAX_NODES = 24;
const MIN_NODE = 32;
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];

/* Cluster by proximity, no wrapping frame. Brick optically centered
 * on 1440×900 (mass center ~720,440); caption hangs 20px under the
 * left edge — the gap is the group, not a box. */
const SEED: CanvasNode[] = [
  { id: "n-rect-a", kind: "rect", x: 584, y: 360, w: 272, h: 152, label: "rect" },
  { id: "n-text", kind: "text", x: 584, y: 532, w: 132, h: 32, label: "真节点 · 能拖" },
];

let seq = 0;
function nextId(): string {
  seq += 1;
  return `n-${seq}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function zoomAt(cam: Camera, p: { x: number; y: number }, z2: number): Camera {
  return {
    x: cam.x + p.x / z2 - p.x / cam.z,
    y: cam.y + p.y / z2 - p.y / cam.z,
    z: z2,
  };
}

function hitNode(nodes: CanvasNode[], wx: number, wy: number): CanvasNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n;
  }
  return null;
}

function inside(outer: CanvasNode, inner: CanvasNode): boolean {
  return (
    inner.id !== outer.id &&
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function applyResize(
  start: CanvasNode,
  corner: Corner,
  dx: number,
  dy: number,
): Pick<CanvasNode, "x" | "y" | "w" | "h"> {
  let { x, y, w, h } = start;
  if (corner.includes("e")) w = start.w + dx;
  if (corner.includes("s")) h = start.h + dy;
  if (corner.includes("w")) {
    w = start.w - dx;
    x = start.x + dx;
  }
  if (corner.includes("n")) {
    h = start.h - dy;
    y = start.y + dy;
  }
  if (w < MIN_NODE) {
    if (corner.includes("w")) x = start.x + start.w - MIN_NODE;
    w = MIN_NODE;
  }
  if (h < MIN_NODE) {
    if (corner.includes("n")) y = start.y + start.h - MIN_NODE;
    h = MIN_NODE;
  }
  return { x, y, w, h };
}

export default function LiveCanvas() {
  const { active, clientToFrame, setEscapeInterceptor } = useScreen();
  const viewRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Camera>({ x: 0, y: 0, z: 1 });
  const nodesRef = useRef<CanvasNode[]>(SEED);
  const [cam, setCam] = useState<Camera>(camRef.current);
  const [nodes, setNodes] = useState<CanvasNode[]>(SEED);
  const [selectedId, setSelectedId] = useState<string | null>("n-rect-a");
  const drag = useRef<Drag | null>(null);

  const commitCam = useCallback((next: Camera) => {
    camRef.current = next;
    setCam(next);
  }, []);

  const commitNodes = useCallback((next: CanvasNode[]) => {
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const frameToWorld = useCallback((fx: number, fy: number) => {
    const c = camRef.current;
    return { x: fx / c.z - c.x, y: fy / c.z - c.y };
  }, []);

  useEffect(() => {
    if (!active) {
      setEscapeInterceptor(null);
      return;
    }
    setEscapeInterceptor(() => {
      if (selectedId) {
        setSelectedId(null);
        return true;
      }
      return false;
    });
    return () => setEscapeInterceptor(null);
  }, [active, selectedId, setEscapeInterceptor]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      const local = clientToFrame({ clientX: e.clientX, clientY: e.clientY });
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const c = camRef.current;
      const z2 = clamp(c.z * factor, Z_MIN, Z_MAX);
      if (z2 === c.z) return;
      commitCam(zoomAt(c, local, z2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, clientToFrame, commitCam]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    if (e.button !== 0 && e.button !== 1) return;
    const t = e.target;
    if (t instanceof Element && t.closest("[data-hud]")) return;
    const local = clientToFrame({ clientX: e.clientX, clientY: e.clientY });
    const world = frameToWorld(local.x, local.y);
    viewRef.current?.setPointerCapture(e.pointerId);

    if (t instanceof HTMLElement && t.dataset.c) {
      const id = t.dataset.node;
      if (!id) return;
      const corner = t.dataset.c as Corner;
      const node = nodesRef.current.find((n) => n.id === id);
      if (node) {
        e.stopPropagation();
        setSelectedId(id);
        drag.current = {
          kind: "resize",
          id,
          corner,
          start: { ...node },
          ox: world.x,
          oy: world.y,
        };
        return;
      }
    }

    const hit = hitNode(nodesRef.current, world.x, world.y);
    if (e.button === 1) {
      drag.current = { kind: "pan", lx: e.clientX, ly: e.clientY };
      return;
    }
    if (hit) {
      setSelectedId(hit.id);
      const extras =
        hit.kind === "frame"
          ? nodesRef.current
              .filter((n) => inside(hit, n))
              .map((n) => ({ id: n.id, ox: n.x, oy: n.y }))
          : [];
      drag.current = {
        kind: "move",
        id: hit.id,
        extras,
        lx: e.clientX,
        ly: e.clientY,
        ox: hit.x,
        oy: hit.y,
      };
      return;
    }
    drag.current = { kind: "pending", x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pending") {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (dx * dx + dy * dy < DRAG_SLOP * DRAG_SLOP) return;
      drag.current = { kind: "pan", lx: e.clientX, ly: e.clientY };
      setSelectedId(null);
      return;
    }
    if (d.kind === "pan") {
      const dx = e.clientX - d.lx;
      const dy = e.clientY - d.ly;
      drag.current = { kind: "pan", lx: e.clientX, ly: e.clientY };
      const c = camRef.current;
      commitCam({ ...c, x: c.x + dx / c.z, y: c.y + dy / c.z });
      return;
    }
    if (d.kind === "resize") {
      const world = frameToWorld(
        clientToFrame({ clientX: e.clientX, clientY: e.clientY }).x,
        clientToFrame({ clientX: e.clientX, clientY: e.clientY }).y,
      );
      const box = applyResize(d.start, d.corner, world.x - d.ox, world.y - d.oy);
      commitNodes(
        nodesRef.current.map((n) => (n.id === d.id ? { ...n, ...box } : n)),
      );
      return;
    }
    const cam = camRef.current;
    const dx = (e.clientX - d.lx) / cam.z;
    const dy = (e.clientY - d.ly) / cam.z;
    const extras = new Map(d.extras.map((ex) => [ex.id, ex]));
    commitNodes(
      nodesRef.current.map((n) => {
        if (n.id === d.id) return { ...n, x: d.ox + dx, y: d.oy + dy };
        const ex = extras.get(n.id);
        if (!ex) return n;
        return { ...n, x: ex.ox + dx, y: ex.oy + dy };
      }),
    );
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (viewRef.current?.hasPointerCapture(e.pointerId)) {
      viewRef.current.releasePointerCapture(e.pointerId);
    }
    if (!d || d.kind !== "pending") return;
    if (nodesRef.current.length >= MAX_NODES) return;
    const local = clientToFrame({ clientX: e.clientX, clientY: e.clientY });
    const world = frameToWorld(local.x, local.y);
    const dropped: CanvasNode = {
      id: nextId(),
      kind: "rect",
      x: world.x - 64,
      y: world.y - 40,
      w: 128,
      h: 80,
      label: "rect",
    };
    commitNodes([...nodesRef.current, dropped]);
    setSelectedId(dropped.id);
  };

  return (
    <div
      ref={viewRef}
      className="wf-canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="wf-world"
        style={{
          transform: `translate(${cam.x * cam.z}px, ${cam.y * cam.z}px) scale(${cam.z})`,
        }}
      >
        <div className="wf-grid" />
        {nodes.map((n) => {
          const selected = n.id === selectedId;
          return (
            <div
              key={n.id}
              className={`wf-node wf-node-${n.kind}${selected ? " is-selected" : ""}`}
              style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
            >
              <span className="wf-caption">{n.label}</span>
              {selected
                ? CORNERS.map((c) => (
                    <i
                      key={c}
                      className="wf-handle"
                      data-c={c}
                      data-node={n.id}
                    />
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
