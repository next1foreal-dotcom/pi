// @vitest-environment jsdom

/**
 * The test the shipped bug got past.
 *
 * Every existing test here renders React under vitest and asserts the line it
 * gets back. That can never catch this defect, because vitest source-maps a
 * stack before any test sees it: by the time the probe reads a frame, the
 * coordinates have already been mapped home. A browser does not do that. It
 * hands over coordinates in the module the dev server built, and those are a
 * different address space — one JSX tag becomes a multi-line call, so the
 * drift grows as you go down a file and no fixed offset describes it.
 *
 * So this file builds the browser's address space on purpose. The module is
 * produced by `transformWithOxc` — the same transform vite 8 runs to serve a
 * .tsx, verified against a live server: a real screen came back as
 * `_jsxDEV(BrowseRow, …)` at 108:33 in a 252-line module for a tag written at
 * 97:17 in a 136-line file. Nothing here is hand-written: the generated
 * coordinates are found by looking for the call in the generated text, the map
 * is the transform's own, and the expected answer is the one a real render
 * under node independently produces from the same fixture.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { transformWithOxc } from "vite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSourceMaps, sourceMapParses } from "../../sourcemap/cache";
import {
  decodeSourceMap,
  inlineSourceMapOf,
  originalPositionFor,
} from "../../sourcemap/decode";
import { ProbeCard } from "./probe-fixture";
import {
  LAB_PACKAGE_DIR,
  locateElement,
  locateElementSourced,
  primeSourceLocations,
  servedModuleUrl,
} from "./source-location";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, LAB_PACKAGE_DIR, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`repo root not found above ${process.cwd()}`);
}

const REPO_ROOT = findRepoRoot();
const FIXTURE_REL = "src/lab/plugins/inspect/probe-fixture.tsx";
const FIXTURE = `${LAB_PACKAGE_DIR}/${FIXTURE_REL}`;
const MODULE_URL = `http://localhost:5180/${FIXTURE_REL}?t=1712`;

type At = { line: number; column: number };

/** The transformed module, with its map inlined the way vite inlines them. */
let servedModule = "";
/** Where the same module puts the two calls the fixture's two tags became. */
let servedButton: At = { line: 0, column: 0 };
let servedDiv: At = { line: 0, column: 0 };

/**
 * V8 reports a call's column at the first character of the callee, which is
 * how `_jsxDEV` at column 33 of a served line was measured against a real
 * server. So finding the callee in the text finds the coordinates the browser
 * would have put in the stack.
 */
function callSite(code: string, callee: string): At {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(callee);
    if (at >= 0) return { line: i + 1, column: at + 1 };
  }
  throw new Error(`no ${callee} in the transformed module`);
}

beforeAll(async () => {
  const source = readFileSync(join(REPO_ROOT, FIXTURE), "utf8");
  // The basename is what vite's dev maps carry in `sources` (`Browse.tsx`, not
  // a path), so the fixture is transformed under the same name.
  const out = await transformWithOxc(source, "probe-fixture.tsx", {
    lang: "tsx",
    jsx: { runtime: "automatic", development: true },
    sourcemap: true,
  });
  const map = out.map;
  if (!map) throw new Error("the transform produced no source map");
  const base64 = Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  servedModule = `${out.code}\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
  servedButton = callSite(out.code, '_jsxDEV("button"');
  servedDiv = callSite(out.code, '_jsxDEV("div"');
});

/** A stack the way chrome writes one: http specs, vendor frames around ours. */
function browserStack(component: string, at: At, url = MODULE_URL): string {
  return [
    "Error: react-stack-top-frame",
    "    at jsxDEV (http://localhost:5180/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=aa:333:13)",
    `    at ${component} (${url}:${at.line}:${at.column})`,
    "    at react_stack_bottom_frame (http://localhost:5180/node_modules/.vite/deps/react-dom_client.js?v=aa:12:3)",
  ].join("\n");
}

/** A node carrying one fiber whose creation stack is `stack`. */
function nodeFrom(stack: string): Element {
  const el = document.createElement("div");
  Object.assign(el, { __reactFiber$served: { _debugStack: { stack }, return: null } });
  document.body.appendChild(el);
  return el;
}

type Fetched = { ok: boolean; text: () => Promise<string> };

/** The dev server, as far as this cares: one module at one URL. */
function serve(body: () => string, url = MODULE_URL) {
  const stub = (input: unknown): Promise<Fetched> =>
    Promise.resolve(
      String(input) === url
        ? { ok: true, text: () => Promise.resolve(body()) }
        : { ok: false, text: () => Promise.resolve("") },
    );
  return vi.spyOn(globalThis, "fetch").mockImplementation(stub as unknown as typeof fetch);
}

let reactRoot: Root | null = null;

/** A really-rendered element, whose stack is in NODE coordinates. */
async function renderProbe(): Promise<Element> {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  reactRoot = createRoot(mount);
  const r = reactRoot;
  await act(async () => {
    r.render(createElement(ProbeCard));
  });
  const el = mount.querySelector(".probe-button");
  if (!el) throw new Error("the probe did not render");
  return el;
}

beforeEach(() => {
  resetSourceMaps();
  document.body.innerHTML = "";
});

afterEach(() => {
  if (reactRoot) {
    const r = reactRoot;
    act(() => {
      r.unmount();
    });
    reactRoot = null;
  }
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("a frame from the browser", () => {
  it("answers with the line in the file, not the line in the module vite served", async () => {
    // The defect in one assertion: the two address spaces do not agree, and
    // this fixture is small — on a real screen the gap was eleven lines.
    expect(servedButton.line).not.toBe(9);
    const spy = serve(() => servedModule);
    const el = nodeFrom(browserStack("ProbeCard", servedButton));

    const loc = await locateElementSourced(el);
    expect(loc.problem).toBeNull();
    expect(loc.file).toBe(FIXTURE);
    expect(loc.component).toBe("ProbeCard");
    expect(loc.line).toBe(9);
    expect(loc.column).toBe(7);
    expect(spy).toHaveBeenCalledWith(MODULE_URL);

    // Parseable is not the same as true. Open the file and look at that spot.
    const text = readFileSync(join(REPO_ROOT, FIXTURE), "utf8").split("\n");
    const at = text[(loc.line as number) - 1].slice((loc.column as number) - 1);
    expect(at.startsWith("<button")).toBe(true);
  });

  it("lands on the same tag node does, from a stack in the other address space", async () => {
    serve(() => servedModule);
    // The same fixture, reached two ways. Node's stack is already in source
    // coordinates; the browser's is not. One answer, or the join between the
    // static index and the running page cannot exist.
    const fromNode = locateElement(await renderProbe());
    const fromBrowser = await locateElementSourced(
      nodeFrom(browserStack("ProbeCard", servedButton)),
    );
    expect(fromNode.problem).toBeNull();
    expect(fromBrowser.file).toBe(fromNode.file);
    expect(fromBrowser.line).toBe(fromNode.line);
    expect(fromBrowser.column).toBe(fromNode.column);
  });

  it("says it is waiting rather than handing back the coordinates it has", () => {
    serve(() => servedModule);
    const loc = locateElement(nodeFrom(browserStack("ProbeCard", servedButton)));
    expect(loc.problem).toBe("source-map-pending");
    expect(loc.line).toBeNull();
    expect(loc.column).toBeNull();
    // The path and the component are known without a map, so they are kept.
    expect(loc.file).toBe(FIXTURE);
    expect(loc.component).toBe("ProbeCard");
  });

  it("reports a problem, not a plausible number, when the module has no map", async () => {
    serve(() => servedModule.replace(/\n\/\/# sourceMappingURL=.*\n?/, "\n"));
    const loc = await locateElementSourced(
      nodeFrom(browserStack("ProbeCard", servedButton)),
    );
    expect(loc.problem).toBe("source-map-unavailable");
    expect(loc.line).toBeNull();
    expect(loc.column).toBeNull();
    expect(loc.file).toBe(FIXTURE);
  });

  it("reports a problem when the module cannot be fetched at all", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const loc = await locateElementSourced(
      nodeFrom(browserStack("ProbeCard", servedButton)),
    );
    expect(loc.problem).toBe("source-map-unavailable");
    expect(loc.line).toBeNull();
  });

  it("reports a problem when that spot in the module maps to nothing", async () => {
    serve(() => servedModule);
    // Column 1 of the last generated line is past every mapping.
    const past = { line: servedModule.split("\n").length - 1, column: 1 };
    const loc = await locateElementSourced(nodeFrom(browserStack("ProbeCard", past)));
    expect(loc.problem).toBe("source-map-unavailable");
    expect(loc.line).toBeNull();
  });

  it("reads and decodes one module's map once, however often it is asked", async () => {
    const spy = serve(() => servedModule);
    const before = sourceMapParses();
    const els = [
      nodeFrom(browserStack("ProbeCard", servedButton)),
      nodeFrom(browserStack("ProbeCard", servedDiv)),
      nodeFrom(browserStack("ProbeCard", servedButton)),
    ];
    for (const el of els) expect((await locateElementSourced(el)).problem).toBeNull();
    // And once more through the synchronous path, which is now a cache hit.
    expect(locateElement(els[0]).line).toBe(9);
    expect(locateElement(els[1]).line).toBe(8);

    expect(sourceMapParses() - before).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not let one module's map answer for another", async () => {
    const other = "http://localhost:5180/src/screens/playground/screen.tsx?t=9";
    serve(() => servedModule);
    const loc = await locateElementSourced(
      nodeFrom(browserStack("Playground", servedButton, other)),
    );
    // The stub serves nothing at that URL, so there is no map — and the answer
    // is a refusal, not the numbers the frame arrived with.
    expect(loc.problem).toBe("source-map-unavailable");
    expect(loc.line).toBeNull();
  });
});

describe("a frame from node", () => {
  it("passes straight through, and nothing goes looking for a source map", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no fetch should happen here"));
    const loc = locateElement(await renderProbe());
    expect(loc.problem).toBeNull();
    expect(loc.file).toBe(FIXTURE);
    expect(loc.line).toBe(9);
    expect(loc.column).toBe(7);
    expect(spy).not.toHaveBeenCalled();
  });

  it("knows which address space a spec is in from the spec itself", () => {
    expect(servedModuleUrl(`http://localhost:5180/${FIXTURE_REL}?t=1712`)).toBe(
      `http://localhost:5180/${FIXTURE_REL}?t=1712`,
    );
    // The cache buster stays: it says WHICH version these coordinates belong to.
    expect(servedModuleUrl("http://h/src/x.tsx?t=2#frag")).toBe("http://h/src/x.tsx?t=2");
    expect(servedModuleUrl("D:/repo/packages/design-lab/src/x.tsx")).toBeNull();
    expect(servedModuleUrl("D:\\repo\\packages\\design-lab\\src\\x.tsx")).toBeNull();
    expect(servedModuleUrl("/home/me/repo/packages/design-lab/src/x.tsx")).toBeNull();
  });
});

describe("priming", () => {
  it("warms the live tree so the synchronous look is an answer, not a wait", async () => {
    serve(() => servedModule);
    const el = nodeFrom(browserStack("ProbeCard", servedButton));
    expect(locateElement(el).problem).toBe("source-map-pending");

    resetSourceMaps();
    await primeSourceLocations(document);

    const loc = locateElement(el);
    expect(loc.problem).toBeNull();
    expect(loc.line).toBe(9);
    expect(loc.column).toBe(7);
  });

  it("collects nothing from a tree whose frames are already source coordinates", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no fetch should happen here"));
    await renderProbe();
    await primeSourceLocations(document);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the map decoder", () => {
  /** `AAAA` is [0,0,0,0]; `U` is a lone generated-column delta of 10. */
  const withHole = JSON.stringify({
    version: 3,
    sources: ["probe-fixture.tsx"],
    names: [],
    mappings: "AAAA,U",
  });

  it("treats a segment with no source as a hole, not as the segment before it", () => {
    const map = decodeSourceMap(withHole);
    expect(map).not.toBeNull();
    const inside = originalPositionFor(map as NonNullable<typeof map>, 1, 5);
    expect(inside).toEqual({ source: "probe-fixture.tsx", line: 1, column: 1 });
    // Past the hole's start there is no original position. Borrowing the one
    // before it is exactly how a lookup lands on a plausible wrong line.
    expect(originalPositionFor(map as NonNullable<typeof map>, 1, 12)).toBeNull();
    // A generated line with no segments at all is not an answer either.
    expect(originalPositionFor(map as NonNullable<typeof map>, 2, 1)).toBeNull();
  });

  it("refuses a map it does not fully understand rather than half-reading it", () => {
    expect(decodeSourceMap("not json")).toBeNull();
    expect(decodeSourceMap(JSON.stringify({ version: 2, sources: [], mappings: "" }))).toBeNull();
    expect(decodeSourceMap(JSON.stringify({ version: 3, sources: [] }))).toBeNull();
    // Two fields is neither a hole (1) nor a mapping (4 or 5).
    expect(
      decodeSourceMap(JSON.stringify({ version: 3, sources: ["a"], mappings: "AA" })),
    ).toBeNull();
    // A character outside the base64 alphabet.
    expect(
      decodeSourceMap(JSON.stringify({ version: 3, sources: ["a"], mappings: "AA*A" })),
    ).toBeNull();
    // A continuation byte with nothing following it.
    expect(
      decodeSourceMap(JSON.stringify({ version: 3, sources: ["a"], mappings: "g" })),
    ).toBeNull();
  });

  it("takes the map out of a module, and only when it is really inline", () => {
    expect(inlineSourceMapOf(servedModule)).toContain('"mappings"');
    const uri = `//# sourceMappingURL=data:application/json,${encodeURIComponent('{"version":3}')}`;
    expect(inlineSourceMapOf(uri)).toBe('{"version":3}');
    // An external map is a second fetch on a guess; it is not read.
    expect(inlineSourceMapOf("//# sourceMappingURL=out.js.map")).toBeNull();
    expect(inlineSourceMapOf("const a = 1;\n")).toBeNull();
  });
});
