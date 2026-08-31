import { describe, expect, it } from "vitest";
import { notifyScreenHotUpdate, subscribeScreenHotUpdate } from "./hmr";

describe("screen HMR bus", () => {
  it("notifies current subscribers only", () => {
    let n = 0;
    const unsub = subscribeScreenHotUpdate(() => {
      n += 1;
    });
    notifyScreenHotUpdate();
    expect(n).toBe(1);
    unsub();
    notifyScreenHotUpdate();
    expect(n).toBe(1);
  });
});
