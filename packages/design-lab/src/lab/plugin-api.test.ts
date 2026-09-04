// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  buildRegistry,
  type LabPlugin,
  type LabPluginHandle,
  publishPluginApis,
} from "./plugin-api";

const stub = (id: string, order?: number): LabPlugin => ({
  id,
  order,
  mount: () => ({ destroy: () => {} }),
});

describe("buildRegistry", () => {
  it("skips a module that exports no plugin, and says which one", () => {
    const warnings: string[] = [];
    const out = buildRegistry(
      { "./plugins/empty/plugin.ts": {}, "./plugins/ok/plugin.ts": { plugin: stub("ok") } },
      (m) => warnings.push(m),
    );
    expect(out.map((p) => p.id)).toEqual(["ok"]);
    expect(warnings.join("\n")).toContain("./plugins/empty/plugin.ts");
  });

  it("accepts a default export as well as a named one", () => {
    const out = buildRegistry({
      "./plugins/a/plugin.ts": { default: stub("a") },
      "./plugins/b/plugin.ts": { plugin: stub("b") },
    });
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps the first of a duplicate id and names the loser", () => {
    const warnings: string[] = [];
    const out = buildRegistry(
      {
        "./plugins/one/plugin.ts": { plugin: stub("dup", 1) },
        "./plugins/two/plugin.ts": { plugin: stub("dup", 2) },
      },
      (m) => warnings.push(m),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.order).toBe(1);
    expect(warnings.join("\n")).toContain("./plugins/two/plugin.ts");
  });

  it("orders by `order`, then by id, so the key broker is deterministic", () => {
    // Folder order (aaa, zzz) deliberately disagrees with declared id order
    // (zebra, alpha): without the id tiebreak this comes back in folder order.
    const out = buildRegistry({
      "./plugins/aaa/plugin.ts": { plugin: stub("zebra", 10) },
      "./plugins/zzz/plugin.ts": { plugin: stub("alpha", 10) },
      "./plugins/mmm/plugin.ts": { plugin: stub("middle") },
    });
    expect(out.map((p) => p.id)).toEqual(["alpha", "zebra", "middle"]);
  });

  it("falls back to the folder name when a plugin declares no id", () => {
    const out = buildRegistry({
      "./plugins/from-folder/plugin.ts": {
        plugin: { id: "", mount: () => ({ destroy: () => {} }) },
      },
    });
    expect(out.map((p) => p.id)).toEqual(["from-folder"]);
  });
});

const handle = (api?: unknown): LabPluginHandle => ({ api, destroy: () => {} });

describe("publishPluginApis", () => {
  afterEach(() => {
    window.lab = undefined;
  });

  it("exposes only the plugins that published an api", () => {
    publishPluginApis([
      { id: "ruler", handle: handle({ addGuide: () => 1 }) },
      { id: "coords", handle: handle() },
    ]);
    expect(window.lab?.plugins()).toEqual(["ruler"]);
    expect(window.lab?.plugin("coords")).toBeUndefined();
  });

  it("hands back the very object the plugin published", () => {
    const api = { addGuide: () => 1 };
    publishPluginApis([{ id: "ruler", handle: handle(api) }]);
    expect(window.lab?.plugin("ruler")).toBe(api);
  });

  it("teardown clears the bridge", () => {
    const off = publishPluginApis([{ id: "ruler", handle: handle({}) }]);
    off();
    expect(window.lab).toBeUndefined();
  });

  it("a stale teardown leaves a newer bridge alone", () => {
    // StrictMode remounts overlap: the old session's cleanup runs after the
    // new session has already published. It must not blank the live one.
    const off = publishPluginApis([{ id: "ruler", handle: handle({ n: 1 }) }]);
    publishPluginApis([{ id: "ruler", handle: handle({ n: 2 }) }]);
    off();
    expect(window.lab?.plugin("ruler")).toEqual({ n: 2 });
  });
});
