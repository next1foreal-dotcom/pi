/**
 * The index against the screens this repo actually has.
 *
 * The fixture tests next door prove the builder does what it says on source it
 * is handed. This one proves it survives contact with real components — the
 * renamed default import, the component nobody exported, the nine
 * `useRef<HTMLDivElement>` that look exactly like JSX tags to a scanner.
 *
 * It needs no dev server and no browser: the compiler reads the files.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LAB_PACKAGE_DIR as INSPECT_PACKAGE_DIR } from "../plugins/inspect/source-location";
import { buildComponentIndex, LAB_PACKAGE_DIR } from "./build-index.ts";
import type { ComponentIndex } from "./types.ts";

/**
 * This package's root and the repo root above it. cwd differs between
 * `vitest --root packages/design-lab` and `npm test` inside the package, so
 * walk rather than assume — the same reasoning as the inspect plugin's test.
 */
function findPackageRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "src/lab/components/build-index.ts"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`design-lab root not found above ${process.cwd()}`);
}

const PACKAGE_ROOT = findPackageRoot();
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");

let cached: ComponentIndex | null = null;
function index(): ComponentIndex {
  cached ??= buildComponentIndex({ packageRoot: PACKAGE_ROOT });
  return cached;
}

describe("the real screens", () => {
  it("agrees with the inspect plugin about where this package lives", () => {
    // The constant is duplicated because the Node-side tsconfig has no DOM lib
    // and cannot load source-location.ts. This is the gate that keeps the two
    // honest; see the note at the top of build-index.ts.
    expect(LAB_PACKAGE_DIR).toBe(INSPECT_PACKAGE_DIR);
  });

  it("finds every screen the canvas glob finds", () => {
    expect(index().screens.map((s) => s.id)).toEqual([
      "playground",
      "product-list",
      "loora-landing",
      "main-landing",
      "mosaic",
    ]);
    expect(index().problems).toEqual([]);
  });

  it("points every instance at a tag that really begins there", () => {
    // The whole value of a location is that opening the file at it lands on
    // the thing. Plausible line numbers are not checked by being plausible.
    const checked: string[] = [];
    for (const c of index().components) {
      for (const at of c.instances) {
        const text = readFileSync(join(REPO_ROOT, at.file), "utf8");
        const line = text.split("\n")[at.line - 1];
        expect(line, `${at.file}:${at.line} is past the end of the file`).toBeDefined();
        expect(
          line.slice(at.column - 1).startsWith(`<${at.tag}`),
          `${at.file}:${at.line}:${at.column} should start "<${at.tag}", found ${JSON.stringify(
            line.slice(at.column - 1, at.column + 30),
          )}`,
        ).toBe(true);
        checked.push(`${c.name}@${at.file}:${at.line}:${at.column}`);
      }
    }
    // A silent zero would pass every assertion above without proving anything.
    expect(checked.length).toBe(9);
  });

  it("keeps a renamed default import under its declared name", () => {
    // `import LocationIcon from "./icons/Location"` — the file declares
    // LocationPin. Keying by the tag would file it under a name that appears
    // nowhere in the component's own source.
    const pin = index().components.find((c) => c.name === "LocationPin");
    expect(pin?.file).toBe(
      `${LAB_PACKAGE_DIR}/src/screens/product-list/components/icons/Location.tsx`,
    );
    expect(pin?.aliases).toEqual(["LocationIcon"]);
    expect(pin?.props).toEqual([{ name: "cls", type: "string", optional: false }]);
  });

  it("indexes the component nobody exported, and says how it was reached", () => {
    const row = index().components.find((c) => c.name === "BrowseRow");
    expect(row?.exported).toBe("local");
    expect(row?.reach).toEqual({
      kind: "component",
      path: ["product-list", "ProductListScreen", "Browse"],
    });
    // And the two it renders are a step further out.
    for (const name of ["ProductImage", "LocationPin"]) {
      expect(index().components.find((c) => c.name === name)?.reach.path).toEqual([
        "product-list",
        "ProductListScreen",
        "Browse",
        "BrowseRow",
      ]);
    }
  });

  it("reads PaneBox's optional prop apart from its required ones", () => {
    const pane = index().components.find((c) => c.name === "PaneBox");
    expect(pane?.exported).toBe("named");
    expect(pane?.props).toEqual([
      { name: "title", type: "string", optional: false },
      { name: "onClose", type: "() => void", optional: true },
      { name: "children", type: "ReactNode", optional: false },
    ]);
  });

  it("does not mistake a generic argument or a vendor tag for a component", () => {
    const names = index().components.map((c) => c.name);
    // Real text in these files: useRef<HTMLDivElement>, useState<MosaicPaneId |
    // null>, <Fragment key=…>, <motion.div>. None of them is a component here.
    for (const wrong of [
      "HTMLDivElement",
      "HTMLElement",
      "MosaicPaneId",
      "MosaicModel",
      "CanvasNode",
      "Camera",
      "Drag",
      "Fragment",
      "div",
    ]) {
      expect(names).not.toContain(wrong);
    }
  });

  it("leaves out a component no screen renders", () => {
    // ProbeCard is a real, exported, rendered-in-a-test component in this
    // package. No screen renders it, so it is not part of this canvas.
    expect(index().components.map((c) => c.name)).not.toContain("ProbeCard");
    expect(index().components.map((c) => c.name)).toEqual([
      "PlaygroundScreen",
      "Tile",
      "ProductListScreen",
      "Browse",
      "BrowseRow",
      "ProductImage",
      "LocationPin",
      "LooraLandingWireframe",
      "LiveCanvas",
      "LandingDesktop",
      "SamanthaLanding",
      "MosaicScreen",
      "PaneBox",
      "MosaicPaneHost",
    ]);
  });

  it("reads the union and the defaults off the one component that has them", () => {
    // This used to record an absence — nothing on these screens had a literal
    // union or a destructuring default — with a note to delete it the day one
    // appeared and assert the values instead. Tile is that day. It exists so
    // the properties panel has something to turn, which makes it deliberately
    // the only place on this canvas with a curated set and defaults.
    //
    // The values are the whole point. `tone?: "quiet" | "loud" | "warning"`
    // coming back as those three strings is the single fact that makes this
    // index worth building with the compiler instead of a regex, and the
    // default is what a knob shows before anyone touches the prop.
    const withLiterals = index().components.flatMap((c) =>
      c.props
        .filter((p) => p.literalValues)
        .map((p) => [`${c.name}.${p.name}`, p.literalValues]),
    );
    const withDefaults = index().components.flatMap((c) =>
      c.props
        .filter((p) => p.defaultValue !== undefined)
        .map((p) => [`${c.name}.${p.name}`, p.defaultValue]),
    );
    // Exact arrays, so this still says "and nothing else has them".
    expect(withLiterals).toEqual([["Tile.tone", ["quiet", "loud", "warning"]]]);
    expect(withDefaults).toEqual([
      ["Tile.gap", "16"],
      ["Tile.dense", "false"],
      ["Tile.ticks", "5"],
      ["Tile.tone", '"quiet"'],
      ["Tile.accent", '"#1c1c1c"'],
    ]);
  });

  it("carries a declared editor off a real screen, not only a fixture", () => {
    // The fixture tests next door prove `@editor` parses out of source handed
    // to the builder. This proves it survives the real compiler on a real
    // component — the half a fixture cannot show, and until now the half that
    // had only ever been checked by hand in a browser.
    const tile = index().components.find((c) => c.name === "Tile");
    expect(tile?.props.find((p) => p.name === "gap")?.editor).toEqual({
      kind: "range",
      min: 0,
      max: 48,
      step: 4,
      unit: "px",
      section: "Spacing",
    });
    // `@editor enum` with no `options=` falls back to the inferred union.
    expect(tile?.props.find((p) => p.name === "tone")?.editor?.options).toEqual([
      "quiet",
      "loud",
      "warning",
    ]);
    // And the copy, which is deliberately not a lever, gets no editor at all.
    expect(tile?.props.find((p) => p.name === "children")?.editor).toBeUndefined();
  });
});
