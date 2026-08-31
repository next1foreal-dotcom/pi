import { describe, it, expect } from "vitest";
import { dispatchLabKey, type KeyInput, type DispatchContext } from "./keyboard-dispatch";

// ─── helpers ──────────────────────────────────────────────────────────

function key(
  overrides: Partial<KeyInput> & { key: string },
): KeyInput {
  return {
    code: "",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  };
}

const EXPLORE: DispatchContext = {
  mode: "explore",
  selectedId: null,
  focusedId: null,
  hasScreens: true,
  isTypingTarget: false,
};

const EXPLORE_SELECTED: DispatchContext = {
  ...EXPLORE,
  selectedId: "screen-1",
};

const FOCUS: DispatchContext = {
  mode: "focus",
  selectedId: "screen-1",
  focusedId: "screen-1",
  hasScreens: true,
  isTypingTarget: false,
};

const FILL: DispatchContext = {
  mode: "fill",
  selectedId: "screen-1",
  focusedId: "screen-1",
  hasScreens: true,
  isTypingTarget: false,
};

const ON_INPUT: DispatchContext = {
  ...EXPLORE,
  isTypingTarget: true,
};

// ─── Tab ──────────────────────────────────────────────────────────────

describe("Tab → cycle-select", () => {
  it("body focus: Tab returns cycle-select forward (must preventDefault)", () => {
    const result = dispatchLabKey(key({ key: "Tab" }), EXPLORE);
    expect(result).toEqual({ action: "cycle-select", direction: 1 });
  });

  it("body focus: Shift+Tab returns cycle-select backward", () => {
    const result = dispatchLabKey(
      key({ key: "Tab", shiftKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "cycle-select", direction: -1 });
  });

  it("input focused: Tab returns null (passthrough to browser)", () => {
    const result = dispatchLabKey(key({ key: "Tab" }), ON_INPUT);
    expect(result).toBeNull();
  });

  it("focus mode: Tab still cycles (table: next screen)", () => {
    const result = dispatchLabKey(key({ key: "Tab" }), FOCUS);
    expect(result).toEqual({ action: "cycle-select", direction: 1 });
  });

  it("fill mode: Tab still cycles (table: swaps filled screen)", () => {
    const result = dispatchLabKey(key({ key: "Tab" }), FILL);
    expect(result).toEqual({ action: "cycle-select", direction: 1 });
  });
});

// ─── Enter ────────────────────────────────────────────────────────────

describe("Enter → lock-into", () => {
  it("explore with selection: lock-into", () => {
    const result = dispatchLabKey(key({ key: "Enter" }), EXPLORE_SELECTED);
    expect(result).toEqual({ action: "lock-into" });
  });

  it("explore without selection: null", () => {
    const result = dispatchLabKey(key({ key: "Enter" }), EXPLORE);
    expect(result).toBeNull();
  });

  it("locked-in mode: null (event goes to the app)", () => {
    const result = dispatchLabKey(key({ key: "Enter" }), FOCUS);
    expect(result).toBeNull();
  });
});

// ─── Escape ───────────────────────────────────────────────────────────

describe("Escape", () => {
  it("explore: deselect", () => {
    const result = dispatchLabKey(key({ key: "Escape" }), EXPLORE);
    expect(result).toEqual({ action: "deselect" });
  });

  it("focus mode: exit-one", () => {
    const result = dispatchLabKey(key({ key: "Escape" }), FOCUS);
    expect(result).toEqual({ action: "exit-one" });
  });

  it("fill mode: exit-one", () => {
    const result = dispatchLabKey(key({ key: "Escape" }), FILL);
    expect(result).toEqual({ action: "exit-one" });
  });

  it("Escape on typing target still works (spec exception)", () => {
    const result = dispatchLabKey(key({ key: "Escape" }), ON_INPUT);
    expect(result).toEqual({ action: "deselect" });
  });
});

// ─── Locked-in gate ───────────────────────────────────────────────────

describe("locked-in mode gates", () => {
  it("Esc passes through in focus", () => {
    expect(dispatchLabKey(key({ key: "Escape" }), FOCUS)?.action).toBe(
      "exit-one",
    );
  });

  it("Shift+1 passes through in focus", () => {
    expect(
      dispatchLabKey(
        key({ key: "!", code: "Digit1", shiftKey: true }),
        FOCUS,
      )?.action,
    ).toBe("fit-all");
  });

  it("Tab passes through in focus", () => {
    expect(dispatchLabKey(key({ key: "Tab" }), FOCUS)?.action).toBe(
      "cycle-select",
    );
  });

  it("Shift+F passes through in focus", () => {
    expect(
      dispatchLabKey(
        key({ key: "F", code: "KeyF", shiftKey: true }),
        FOCUS,
      )?.action,
    ).toBe("fill-toggle");
  });

  it("+/- zoom in focus mode works", () => {
    expect(dispatchLabKey(key({ key: "+" }), FOCUS)?.action).toBe("zoom-step");
  });

  it("+/- zoom in fill mode → null (fill has nothing to zoom)", () => {
    expect(dispatchLabKey(key({ key: "+" }), FILL)).toBeNull();
  });

  it("Enter in focus → null", () => {
    expect(dispatchLabKey(key({ key: "Enter" }), FOCUS)).toBeNull();
  });

  it("Delete in focus → null", () => {
    expect(dispatchLabKey(key({ key: "Delete" }), FOCUS)).toBeNull();
  });

  it("⌘D in focus → null", () => {
    expect(
      dispatchLabKey(key({ key: "d", code: "KeyD", metaKey: true }), FOCUS),
    ).toBeNull();
  });

  it("Arrow keys in focus → null", () => {
    expect(dispatchLabKey(key({ key: "ArrowLeft" }), FOCUS)).toBeNull();
  });
});

// ─── Shift+1 ──────────────────────────────────────────────────────────

describe("Shift+1 → fit-all", () => {
  it("explore: fit-all", () => {
    const result = dispatchLabKey(
      key({ key: "!", code: "Digit1", shiftKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "fit-all" });
  });

  it("focus: fit-all (exit then fit)", () => {
    const result = dispatchLabKey(
      key({ key: "!", code: "Digit1", shiftKey: true }),
      FOCUS,
    );
    expect(result).toEqual({ action: "fit-all" });
  });
});

// ─── Shift+2 ──────────────────────────────────────────────────────────

describe("Shift+2 → zoom-to-selection", () => {
  it("explore with selection: zoom-to-selection", () => {
    const result = dispatchLabKey(
      key({ key: "@", code: "Digit2", shiftKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "zoom-to-selection" });
  });

  it("explore without selection: null", () => {
    const result = dispatchLabKey(
      key({ key: "@", code: "Digit2", shiftKey: true }),
      EXPLORE,
    );
    expect(result).toBeNull();
  });
});

// ─── Shift+0 ──────────────────────────────────────────────────────────

describe("Shift+0 → zoom-100", () => {
  it("explore: zoom-100", () => {
    const result = dispatchLabKey(
      key({ key: ")", code: "Digit0", shiftKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "zoom-100" });
  });
});

// ─── Shift+F ──────────────────────────────────────────────────────────

describe("Shift+F → fill-toggle", () => {
  it("explore: fill-toggle", () => {
    const result = dispatchLabKey(
      key({ key: "F", code: "KeyF", shiftKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "fill-toggle" });
  });
});

// ─── Zoom +/- ─────────────────────────────────────────────────────────

describe("zoom step", () => {
  it("+ in explore → zoom-in", () => {
    const result = dispatchLabKey(key({ key: "+" }), EXPLORE);
    expect(result).toEqual({ action: "zoom-step", direction: 1 });
  });

  it("- in explore → zoom-out", () => {
    const result = dispatchLabKey(key({ key: "-" }), EXPLORE);
    expect(result).toEqual({ action: "zoom-step", direction: -1 });
  });

  it("= (unshifted +) in explore → zoom-in", () => {
    const result = dispatchLabKey(
      key({ key: "=", code: "Equal" }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "zoom-step", direction: 1 });
  });
});

// ─── ⌘D duplicate ────────────────────────────────────────────────────

describe("⌘D → duplicate", () => {
  it("explore with selection + meta: duplicate", () => {
    const result = dispatchLabKey(
      key({ key: "d", code: "KeyD", metaKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "duplicate" });
  });

  it("explore with selection + ctrl: duplicate", () => {
    const result = dispatchLabKey(
      key({ key: "d", code: "KeyD", ctrlKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "duplicate" });
  });

  it("no selection → null", () => {
    const result = dispatchLabKey(
      key({ key: "d", code: "KeyD", metaKey: true }),
      EXPLORE,
    );
    expect(result).toBeNull();
  });
});

// ─── Delete ───────────────────────────────────────────────────────────

describe("Delete / Backspace → delete-screen", () => {
  it("Delete with selection: delete-screen", () => {
    const result = dispatchLabKey(
      key({ key: "Delete" }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "delete-screen" });
  });

  it("Backspace with selection: delete-screen", () => {
    const result = dispatchLabKey(
      key({ key: "Backspace" }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "delete-screen" });
  });

  it("Shift+Delete → null (Shift guard)", () => {
    const result = dispatchLabKey(
      key({ key: "Delete", shiftKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toBeNull();
  });
});

// ─── Undo / Redo ──────────────────────────────────────────────────────

describe("undo / redo", () => {
  it("⌘Z → undo", () => {
    const result = dispatchLabKey(
      key({ key: "z", code: "KeyZ", metaKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "undo" });
  });

  it("⌘Shift+Z → redo", () => {
    const result = dispatchLabKey(
      key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "redo" });
  });

  it("Ctrl+Y → redo", () => {
    const result = dispatchLabKey(
      key({ key: "y", code: "KeyY", ctrlKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "redo" });
  });
});

// ─── Ctrl+C cleanup ──────────────────────────────────────────────────

describe("Ctrl+C → cleanup", () => {
  it("Ctrl+C without meta: cleanup", () => {
    const result = dispatchLabKey(
      key({ key: "c", code: "KeyC", ctrlKey: true }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "cleanup" });
  });

  it("⌘C (meta set) → null (not cleanup)", () => {
    const result = dispatchLabKey(
      key({ key: "c", code: "KeyC", metaKey: true }),
      EXPLORE,
    );
    // On Mac, metaKey is the "Cmd" key. Ctrl+C cleanup only fires when
    // ctrlKey is true and metaKey is false.
    expect(result).toBeNull();
  });
});

// ─── Reset layout ─────────────────────────────────────────────────────

describe("Shift+⌘+Backspace → reset-layout", () => {
  it("explore: reset-layout", () => {
    const result = dispatchLabKey(
      key({
        key: "Backspace",
        code: "Backspace",
        shiftKey: true,
        metaKey: true,
      }),
      EXPLORE,
    );
    expect(result).toEqual({ action: "reset-layout" });
  });
});

// ─── Arrow nudge ──────────────────────────────────────────────────────

describe("arrow nudge", () => {
  it("ArrowLeft with selection: nudge left 1px", () => {
    const result = dispatchLabKey(
      key({ key: "ArrowLeft" }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "nudge", dx: -1, dy: 0 });
  });

  it("Shift+ArrowRight: nudge right 10px", () => {
    const result = dispatchLabKey(
      key({ key: "ArrowRight", shiftKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "nudge", dx: 10, dy: 0 });
  });

  it("ArrowUp: nudge up 1px", () => {
    const result = dispatchLabKey(
      key({ key: "ArrowUp" }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "nudge", dx: 0, dy: -1 });
  });

  it("Shift+ArrowDown: nudge down 10px", () => {
    const result = dispatchLabKey(
      key({ key: "ArrowDown", shiftKey: true }),
      EXPLORE_SELECTED,
    );
    expect(result).toEqual({ action: "nudge", dx: 0, dy: 10 });
  });

  it("Arrow without selection: null", () => {
    const result = dispatchLabKey(key({ key: "ArrowLeft" }), EXPLORE);
    expect(result).toBeNull();
  });
});

// ─── typing target blocks everything except Escape ────────────────────

describe("typing target", () => {
  it("Escape passes through", () => {
    expect(
      dispatchLabKey(key({ key: "Escape" }), ON_INPUT),
    ).not.toBeNull();
  });

  it("Tab is blocked", () => {
    expect(dispatchLabKey(key({ key: "Tab" }), ON_INPUT)).toBeNull();
  });

  it("Enter is blocked", () => {
    expect(dispatchLabKey(key({ key: "Enter" }), ON_INPUT)).toBeNull();
  });

  it("Shift+1 is blocked", () => {
    expect(
      dispatchLabKey(
        key({ key: "!", code: "Digit1", shiftKey: true }),
        ON_INPUT,
      ),
    ).toBeNull();
  });

  it("Arrow keys are blocked", () => {
    expect(
      dispatchLabKey(key({ key: "ArrowLeft" }), {
        ...EXPLORE_SELECTED,
        isTypingTarget: true,
      }),
    ).toBeNull();
  });
});
