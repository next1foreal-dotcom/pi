import { useState } from "react";
import { useScreen } from "../../lab/screen-context";

export const name = "Playground";
export const width = 1440;
export const height = 900;
export const position = { x: 0, y: 0 };

export default function PlaygroundScreen() {
  const { active, visible, frameSize } = useScreen();
  const [count, setCount] = useState(0);
  const [text, setText] = useState("");

  return (
    <div
      style={{
        minHeight: "100%",
        padding: 64,
        boxSizing: "border-box",
        fontFamily: "Inter, system-ui, sans-serif",
        color: "#1c1c1c",
        background: "#fff",
      }}
    >
      <h1 style={{ fontSize: 40, fontWeight: 600, margin: 0 }}>Playground</h1>
      <p style={{ color: "#6b6b6b", marginTop: 12 }}>
        {active ? "Locked in — this screen is live." : "Explore mode — inert."}
        {visible ? "" : " (culled)"}
      </p>
      <p style={{ color: "#6b6b6b" }}>
        Frame {Math.round(frameSize.width)} × {Math.round(frameSize.height)}
      </p>
      <button
        type="button"
        onClick={() => setCount((n) => n + 1)}
        style={{
          marginTop: 24,
          padding: "10px 16px",
          borderRadius: 8,
          border: "1px solid #d9d9d9",
          background: "#f5f5f5",
          font: "inherit",
          cursor: "pointer",
        }}
      >
        Count {count}
      </button>
      <div style={{ marginTop: 16 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type here when locked in"
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #d9d9d9",
            font: "inherit",
            width: 320,
          }}
        />
      </div>
    </div>
  );
}
