/**
 * Declared editors: `@editor` on a prop overlays inference. No tag means the
 * index is unchanged — that is the property this file exists to protect.
 */

import { describe, expect, it } from "vitest";
import { buildComponentIndex } from "./build-index.ts";
import type { ComponentEntry, ComponentIndex } from "./types.ts";

const ROOT = "/virtual/design-lab";
const SCREENS = `${ROOT}/src/screens`;

function build(files: Record<string, string>): ComponentIndex {
  const screenFiles = Object.keys(files).filter((f) => f.endsWith("/screen.tsx"));
  return buildComponentIndex({ packageRoot: ROOT, screenFiles, files });
}

function get(index: ComponentIndex, name: string): ComponentEntry {
  const hit = index.components.find((c) => c.name === name);
  if (!hit) {
    throw new Error(
      `no component "${name}" in [${index.components.map((c) => c.name).join(", ")}]`,
    );
  }
  return hit;
}

/** One screen that renders `<Widget />` from the given component source. */
function widgetIndex(componentSrc: string): ComponentIndex {
  return build({
    [`${SCREENS}/one/screen.tsx`]: `
import { Widget } from "../../components/Widget";
export default function OneScreen() {
  return <Widget />;
}
`,
    [`${ROOT}/src/components/Widget.tsx`]: componentSrc,
  });
}

function propOf(index: ComponentIndex, name: string) {
  const p = get(index, "Widget").props.find((x) => x.name === name);
  if (!p) {
    throw new Error(
      `no prop "${name}" on Widget [${get(index, "Widget").props.map((x) => x.name).join(", ")}]`,
    );
  }
  return p;
}

describe("no @editor means inference-only output", () => {
  it("keeps a prop without @editor byte-identical to today's inferred shape", () => {
    // Would pass before any parser existed — that is the trap. It goes red
    // the moment an implementation stamps `editor` onto undeclared props
    // (empty object, undefined own-key, anything). Pair with the mixed-prop
    // test below, which is red until the declared half is actually read.
    const index = widgetIndex(`
export function Widget({ variant }: { variant?: "ghost" | "solid" | "outline" }) {
  return <button className={variant} />;
}
`);
    const variant = propOf(index, "variant");
    expect(Object.hasOwn(variant, "editor")).toBe(false);
    expect(JSON.parse(JSON.stringify(variant))).toEqual({
      name: "variant",
      type: '"ghost" | "solid" | "outline"',
      optional: true,
      literalValues: ["ghost", "solid", "outline"],
    });
    expect(index.problems).toEqual([]);
  });

  it("does not grow an editor on a sibling that has no tag", () => {
    // The tautology-breaker: one prop declared, one not. Before a parser
    // exists this is red because `gap.editor` is missing. A parser that
    // stamps `editor` onto every prop then fails on `label`.
    const index = widgetIndex(`
type Props = {
  /** @editor range min=0 max=64 step=4 unit=px section=Spacing */
  gap?: number;
  label: string;
};
export function Widget({ gap, label }: Props) {
  return <div>{label}{gap}</div>;
}
`);
    const gap = propOf(index, "gap");
    expect(gap).toEqual({
      name: "gap",
      type: "number",
      optional: true,
      editor: {
        kind: "range",
        min: 0,
        max: 64,
        step: 4,
        unit: "px",
        section: "Spacing",
      },
    });
    const label = propOf(index, "label");
    expect(Object.hasOwn(label, "editor")).toBe(false);
    expect(label).toEqual({
      name: "label",
      type: "string",
      optional: false,
    });
    expect(index.problems).toEqual([]);
  });
});

describe("@editor kinds", () => {
  it("reads color, including a curated palette on a plain string", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor color options=#e8e0d5,#1c1c1c,#c45c26 section=Colour */
  accent?: string;
};
export function Widget({ accent }: Props) {
  return <i style={{ color: accent }} />;
}
`);
    expect(propOf(index, "accent").editor).toEqual({
      kind: "color",
      options: ["#e8e0d5", "#1c1c1c", "#c45c26"],
      section: "Colour",
    });
    expect(index.problems).toEqual([]);
  });

  it("reads int and boolean", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor int min=1 max=6 */
  level?: number;
  /** @editor boolean */
  compact?: boolean;
};
export function Widget({ level, compact }: Props) {
  return <b data-level={level} data-compact={compact} />;
}
`);
    expect(propOf(index, "level").editor).toEqual({
      kind: "int",
      min: 1,
      max: 6,
    });
    expect(propOf(index, "compact").editor).toEqual({ kind: "boolean" });
    expect(index.problems).toEqual([]);
  });
});

describe("@editor enum", () => {
  it("narrows options to a curated subset of the literal union", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor enum options=ghost,solid section=Look */
  variant?: "ghost" | "solid" | "outline";
};
export function Widget({ variant }: Props) {
  return <button className={variant} />;
}
`);
    const variant = propOf(index, "variant");
    expect(variant.literalValues).toEqual(["ghost", "solid", "outline"]);
    expect(variant.editor).toEqual({
      kind: "enum",
      options: ["ghost", "solid"],
      section: "Look",
    });
    expect(index.problems).toEqual([]);
  });

  it("rejects options that expand past the literal union", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor enum options=ghost,z */
  variant?: "ghost" | "solid" | "outline";
};
export function Widget({ variant }: Props) {
  return <button className={variant} />;
}
`);
    const variant = propOf(index, "variant");
    expect(Object.hasOwn(variant, "editor")).toBe(false);
    expect(variant.literalValues).toEqual(["ghost", "solid", "outline"]);
    expect(index.problems).toEqual([
      'Widget.variant: @editor enum lists "z", which the type ("ghost" | "solid" | "outline") does not allow. Remove "z" from options, or widen the type.',
    ]);
  });

  it("fills options from literalValues when options= is omitted", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor enum section=Look */
  variant?: "ghost" | "solid" | "outline";
};
export function Widget({ variant }: Props) {
  return <button className={variant} />;
}
`);
    expect(propOf(index, "variant").editor).toEqual({
      kind: "enum",
      options: ["ghost", "solid", "outline"],
      section: "Look",
    });
    expect(index.problems).toEqual([]);
  });

  it("records a problem when enum has no options and the type is not a literal union", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor enum */
  variant?: string;
};
export function Widget({ variant }: Props) {
  return <button className={variant} />;
}
`);
    expect(Object.hasOwn(propOf(index, "variant"), "editor")).toBe(false);
    expect(index.problems).toEqual([
      "Widget.variant: @editor enum has no options, and the type is not a union of string literals. Add options=…, or declare the prop as a string-literal union.",
    ]);
  });
});

describe("@editor problems", () => {
  it("treats an unknown editor name as a problem, not a skip", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor slider min=0 max=64 */
  gap?: number;
};
export function Widget({ gap }: Props) {
  return <div>{gap}</div>;
}
`);
    expect(Object.hasOwn(propOf(index, "gap"), "editor")).toBe(false);
    expect(index.problems).toEqual([
      'Widget.gap: @editor "slider" is not one of color, int, range, enum, boolean. Use one of those five.',
    ]);
  });

  it("treats min greater than max as a problem", () => {
    const index = widgetIndex(`
type Props = {
  /** @editor range min=64 max=0 */
  gap?: number;
};
export function Widget({ gap }: Props) {
  return <div>{gap}</div>;
}
`);
    expect(Object.hasOwn(propOf(index, "gap"), "editor")).toBe(false);
    expect(index.problems).toEqual([
      "Widget.gap: @editor range has min=64 greater than max=0. Swap them, or correct the bounds.",
    ]);
  });
});
