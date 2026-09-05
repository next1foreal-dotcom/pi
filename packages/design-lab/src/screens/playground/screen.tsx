import { useState } from "react";
import { useScreen } from "../../lab/screen-context";
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
      </div>
    </div>
  );
}
