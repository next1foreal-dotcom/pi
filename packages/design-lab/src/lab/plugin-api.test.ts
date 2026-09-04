// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { CanvasRuler } from "./core/canvas-ruler";
import { Labels } from "./core/page-labels";
import { StickyNotes } from "./core/page-notes";
import {
  buildRegistry,
  checkApiDocs,
  type LabPlugin,
  type LabPluginHandle,
  type PluginApiDoc,
  publishPluginApis,
} from "./plugin-api";
import { plugin as labelsPlugin } from "./plugins/labels/plugin";
import { plugin as notesPlugin } from "./plugins/notes/plugin";
import { plugin as rulerPlugin } from "./plugins/ruler/plugin";

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
const quiet = () => {};

describe("publishPluginApis", () => {
  afterEach(() => {
    window.lab = undefined;
  });

  it("exposes only the plugins that published an api", () => {
    publishPluginApis([
      { id: "ruler", handle: handle({ addGuide: () => 1 }) },
      { id: "coords", handle: handle() },
    ], quiet);
    expect(window.lab?.plugins()).toEqual(["ruler"]);
    expect(window.lab?.plugin("coords")).toBeUndefined();
  });

  it("hands back the very object the plugin published", () => {
    const api = { addGuide: () => 1 };
    publishPluginApis([{ id: "ruler", handle: handle(api) }], quiet);
    expect(window.lab?.plugin("ruler")).toBe(api);
  });

  it("teardown clears the bridge", () => {
    const off = publishPluginApis([{ id: "ruler", handle: handle({}) }], quiet);
    off();
    expect(window.lab).toBeUndefined();
  });

  it("a stale teardown leaves a newer bridge alone", () => {
    // StrictMode remounts overlap: the old session's cleanup runs after the
    // new session has already published. It must not blank the live one.
    const off = publishPluginApis(
      [{ id: "ruler", handle: handle({ n: 1 }) }],
      quiet,
    );
    publishPluginApis([{ id: "ruler", handle: handle({ n: 2 }) }], quiet);
    off();
    expect(window.lab?.plugin("ruler")).toEqual({ n: 2 });
  });
});

const doc = (name: string): PluginApiDoc => ({
  name,
  signature: `${name}()`,
  summary: "",
});

describe("checkApiDocs", () => {
  it("passes docs that match the api", () => {
    expect(checkApiDocs("x", { a: () => 1 }, [doc("a")])).toEqual([]);
  });

  it("catches a documented name the api does not have", () => {
    const [problem] = checkApiDocs("ruler", { a: () => 1 }, [doc("b")]);
    expect(problem).toContain('documents "b"');
  });

  it("catches a name documented twice", () => {
    const problems = checkApiDocs("x", { a: () => 1 }, [doc("a"), doc("a")]);
    expect(problems.some((p) => p.includes("twice"))).toBe(true);
  });

  it("catches an api published with no docs at all", () => {
    expect(checkApiDocs("x", { a: () => 1 }, undefined)).toEqual([
      '[lab] plugin "x" publishes an api but describes nothing',
    ]);
  });

  it("says nothing about a plugin that publishes no api", () => {
    expect(checkApiDocs("coords", undefined, undefined)).toEqual([]);
  });
});

describe("shipped plugins describe what they publish", () => {
  // Drift gate: rename or drop a method and the docs go red with it.
  const cases: [LabPlugin, object][] = [
    [rulerPlugin, CanvasRuler.prototype],
    [notesPlugin, StickyNotes.prototype],
    [labelsPlugin, Labels.prototype],
  ];
  for (const [plugin, proto] of cases) {
    it(`${plugin.id} documents only methods that exist`, () => {
      const docs = plugin.describe ?? [];
      expect(docs.length).toBeGreaterThan(0);
      const bag = proto as Record<string, unknown>;
      const phantom = docs
        .filter((d) => typeof bag[d.name] !== "function")
        .map((d) => d.name);
      expect(phantom).toEqual([]);
      for (const d of docs) {
        expect(d.signature).toContain(d.name);
        expect(d.summary.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("the bridge hands the docs over", () => {
  afterEach(() => {
    window.lab = undefined;
  });

  it("describe returns one plugin's docs, help returns all of them", () => {
    publishPluginApis(
      [
        { id: "ruler", handle: handle({ a: () => 1 }), docs: [doc("a")] },
        { id: "notes", handle: handle({ b: () => 1 }), docs: [doc("b")] },
      ],
      quiet,
    );
    expect(window.lab?.describe("ruler").map((d) => d.name)).toEqual(["a"]);
    expect(Object.keys(window.lab?.help() ?? {})).toEqual(["ruler", "notes"]);
  });

  it("describe is empty for a plugin that published nothing", () => {
    publishPluginApis([{ id: "coords", handle: handle() }], quiet);
    expect(window.lab?.describe("coords")).toEqual([]);
  });
});
