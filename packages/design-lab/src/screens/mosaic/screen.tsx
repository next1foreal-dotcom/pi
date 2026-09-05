import { useCallback, useState } from "react";
import { useScreen } from "../../lab/screen-context";
import { MosaicPaneHost } from "./components/MosaicPaneHost";
import { PaneBox } from "./components/PaneBox";
import type { MosaicModel, MosaicPaneId } from "./model";
import "./styles/mosaic.css";

export const name = "Mosaic";
export const width = 1440;
export const height = 900;
/* Right of loora (x 3400 + w 1440 = 4840) at the same 320 gap loora itself
 * takes from product-list. (The playground → product-list gap is 200; 320 is
 * the more recent of the two.) */
export const position = { x: 5160, y: 0 };

const LABELS: Record<string, string> = {
  bg: "Background tasks",
  tasks: "Tasks",
  browser: "Browser",
  terminal: "Terminal",
  diff: "Working tree",
};

const BODY: Record<string, string> = {
  bg: "Drag the divider on the right. The column follows the cursor at any camera zoom — that is the whole reason this screen exists.",
  tasks:
    "Drag the hairline between these two panes. The 140px row floor is measured in FRAME pixels, so it stays 140px of this page whatever the lab is zoomed to.",
  browser:
    "Double-click a divider to even-split the pair it sits between. Ctrl+] and Ctrl+[ move the focus ring; Ctrl+Alt+arrow moves it by geometry.",
  terminal:
    "Those shortcuts are gated on the screen being locked in. In explore mode this whole page is a picture and answers no keys.",
  diff: "Narrow the frame and the grid collapses: one column under 1080px (3 × the 360px floor), the focused pane alone under 768px.",
};

const INITIAL: MosaicModel = {
  v: 2,
  columns: [
    {
      size: 34,
      panes: [
        { id: "bg", size: 55 },
        { id: "tasks", size: 45 },
      ],
    },
    { size: 33, panes: [{ id: "browser", size: 100 }] },
    {
      size: 33,
      panes: [
        { id: "terminal", size: 50 },
        { id: "diff", size: 50 },
      ],
    },
  ],
};

export default function MosaicScreen() {
  const { frameSize } = useScreen();
  const [model, setModel] = useState<MosaicModel>(INITIAL);

  const renderPane = useCallback(
    (id: MosaicPaneId) => (
      <PaneBox title={LABELS[id] ?? id}>
        <p>
          <strong>{LABELS[id] ?? id}</strong>
        </p>
        <p>{BODY[id] ?? "Placeholder content, so the cell has something in it."}</p>
      </PaneBox>
    ),
    [],
  );

  return (
    <div className="mos-screen" style={{ height: frameSize.height }}>
      <div className="mos-head">
        <b>Mosaic</b>
        <span className="mos-head-keys">
          Drag a divider · double-click to even-split · Ctrl+] / Ctrl+[ ·
          Ctrl+Alt+arrow
        </span>
        <button
          type="button"
          className="mos-head-reset"
          onClick={() => setModel(INITIAL)}
        >
          Reset
        </button>
      </div>
      <MosaicPaneHost
        model={model}
        onLayout={setModel}
        renderPane={renderPane}
      />
    </div>
  );
}
