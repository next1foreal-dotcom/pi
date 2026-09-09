import { useState } from "react";
import { useScreen } from "../../lab/screen-context";
import Tile from "./components/Tile";
import "./styles/screen.css";

export const name = "Playground";
export const width = 1440;
export const height = 900;
export const position = { x: 0, y: 0 };

export default function PlaygroundScreen() {
  const { active, visible, frameSize } = useScreen();
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");

  return (
    <div className="pg-root">
      <div className="pg-page">
        <h1 className="pg-title">Playground</h1>
        <p className="pg-note">
          {active ? "Locked in — this screen is live." : "Explore mode — inert."}
          {visible ? "" : " (culled)"}
        </p>
        <p className="pg-note">
          Frame {Math.round(frameSize.width)} × {Math.round(frameSize.height)}
        </p>
        <button
          type="button"
          className="pg-btn"
          onClick={() => setCount((n) => n + 1)}
        >
          Count {count}
        </button>
        <div className="pg-field">
          <input
            className="pg-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type here when locked in"
          />
        </div>
        {/*
          Literal props, on purpose: this is the one call site on the canvas
          the properties panel can actually turn. Written as expressions
          (`gap={someVar}`) the editor would refuse them, and rightly.
          The copy is children, not props — a knob is a lever.
        */}
        <div className="pg-tile-slot">
          <Tile gap={8} dense={false} ticks={5} tone="quiet" accent="#1c1c1c">
            <h2 className="pg-tile-head">Knobs</h2>
            <p className="pg-tile-copy">
              Five declared editors, one call site. Turn one in the panel and
              this file changes.
            </p>
          </Tile>
        </div>
      </div>
    </div>
  );
}
