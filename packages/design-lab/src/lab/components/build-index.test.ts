/**
 * The index builder, on source text it is handed. No dev server, no browser,
 * no repo files — the fixtures below are the whole world the compiler sees, so
 * a failure here is the builder's and nothing else's.
 */

import { describe, expect, it } from "vitest";
import { buildComponentIndex, LAB_PACKAGE_DIR } from "./build-index.ts";
import type { ComponentEntry, ComponentIndex } from "./types.ts";

const ROOT = "/virtual/design-lab";
const SCREENS = `${ROOT}/src/screens`;

/** Build from a `path -> source` map, with `src/screens/(dir)/screen.tsx` as roots. */
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

describe("props", () => {
  it("reads a union of string literals back as those literals, not as string", () => {
    // The one fact this whole index is built to carry. A `type` of "string"
    // here would make every control built on it wrong.
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { Button } from "../../components/Button";
export default function OneScreen() {
  return <Button variant="ghost" />;
}
`,
      [`${ROOT}/src/components/Button.tsx`]: `
export function Button({ variant }: { variant?: "ghost" | "solid" | "outline" }) {
  return <button className={variant} />;
}
`,
    });
    const variant = get(index, "Button").props[0];
    expect(variant.name).toBe("variant");
    expect(variant.literalValues).toEqual(["ghost", "solid", "outline"]);
    expect(variant.type).toBe('"ghost" | "solid" | "outline"');
  });

  it("follows a type alias to the literals behind it", () => {
    // `tone: Tone` — the three strings are in another declaration entirely.
    // This is the case no amount of regexing the component file can reach.
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { Badge } from "../../components/Badge";
export default function OneScreen() {
  return <Badge tone="loud" />;
}
`,
      [`${ROOT}/src/components/Badge.tsx`]: `
import type { Tone } from "./tone";
export function Badge({ tone }: { tone: Tone }) {
  return <span data-tone={tone} />;
}
`,
      [`${ROOT}/src/components/tone.ts`]: `
export type Tone = "quiet" | "loud" | "urgent";
`,
    });
    const tone = get(index, "Badge").props[0];
    expect(tone.literalValues).toEqual(["quiet", "loud", "urgent"]);
    // The printed type keeps the alias, which is what a reader wants to see.
    expect(tone.type).toBe("Tone");
  });

  it("reports an optional prop's default as well as its optionality", () => {
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { Button } from "../../components/Button";
export default function OneScreen() {
  return <Button />;
}
`,
      [`${ROOT}/src/components/Button.tsx`]: `
export function Button({ variant = "solid", size: s = 2, label }: {
  variant?: "ghost" | "solid" | "outline";
  size?: number;
  label: string;
}) {
  return <button data-size={s}>{variant}{label}</button>;
}
`,
    });
    const props = get(index, "Button").props;
    const variant = props.find((p) => p.name === "variant");
    expect(variant?.optional).toBe(true);
    expect(variant?.defaultValue).toBe('"solid"');

    // Renamed in the destructuring: the default still belongs to `size`.
    const size = props.find((p) => p.name === "size");
    expect(size?.optional).toBe(true);
    expect(size?.defaultValue).toBe("2");

    // Optionality and defaults are separate facts, and both are reported.
    const label = props.find((p) => p.name === "label");
    expect(label?.optional).toBe(false);
    expect(label?.defaultValue).toBeUndefined();
  });

  it("withholds literal values when the union is not all literals", () => {
    // Half a set of legal values is worse than none: a control built from
    // ["a","b"] would forbid every number, which the component accepts.
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { Mixed } from "../../components/Mixed";
export default function OneScreen() {
  return <Mixed value="a" />;
}
`,
      [`${ROOT}/src/components/Mixed.tsx`]: `
export function Mixed({ value }: { value: "a" | "b" | number }) {
  return <i>{value}</i>;
}
`,
    });
    const value = get(index, "Mixed").props[0];
    expect(value.literalValues).toBeUndefined();
    // The checker prints unions in its own canonical order (primitives first),
    // and the whole type is still there to be read.
    expect(value.type).toBe('number | "a" | "b"');
  });
});

describe("discovery is by use", () => {
  const graph = {
    [`${SCREENS}/one/screen.tsx`]: `
import { Card } from "../../components/Card";
export default function OneScreen() {
  return <Card />;
}
`,
    [`${ROOT}/src/components/Card.tsx`]: `
import { Avatar } from "./Avatar";
export function Card() {
  return <div><Avatar size="lg" /></div>;
}
`,
    [`${ROOT}/src/components/Avatar.tsx`]: `
export function Avatar({ size }: { size: "sm" | "lg" }) {
  return <img alt="" data-size={size} />;
}
`,
    [`${ROOT}/src/components/Orphan.tsx`]: `
export function Orphan({ n }: { n: number }) {
  return <b>{n}</b>;
}
`,
  };

  it("indexes a component reached only through another, and says how", () => {
    const index = build(graph);
    const avatar = get(index, "Avatar");
    expect(avatar.reach.kind).toBe("component");
    expect(avatar.reach.path).toEqual(["one", "OneScreen", "Card"]);
    expect(avatar.screens).toEqual(["one"]);
    // And the one the screen renders itself is marked differently.
    expect(get(index, "Card").reach).toEqual({
      kind: "screen",
      path: ["one", "OneScreen"],
    });
    expect(get(index, "OneScreen").reach.kind).toBe("screen-root");
  });

  it("leaves out a component nobody renders", () => {
    const index = build(graph);
    // Orphan is exported, type-checks, and sits right beside Card. Nothing
    // renders it, so it is not part of this canvas's system.
    expect(index.components.map((c) => c.name)).toEqual([
      "OneScreen",
      "Card",
      "Avatar",
    ]);
  });

  it("counts a component reached from two screens once, under both", () => {
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { Card } from "../../components/Card";
export default function OneScreen() {
  return <Card />;
}
`,
      [`${SCREENS}/two/screen.tsx`]: `
import { Card } from "../../components/Card";
export default function TwoScreen() {
  return <div><Card /><Card /></div>;
}
`,
      [`${ROOT}/src/components/Card.tsx`]: `
export function Card() {
  return <div />;
}
`,
    });
    const card = get(index, "Card");
    // The propagation answer: change Card and these are the screens that moved.
    expect(card.screens).toEqual(["one", "two"]);
    expect(card.instances.map((i) => `${i.screenId}:${i.line}`)).toEqual([
      "one:4",
      "two:4",
      "two:4",
    ]);
  });
});

describe("what counts as a component", () => {
  it("ignores host elements, vendor components and generic arguments", () => {
    // `useRef<HTMLDivElement>(null)` is the trap: to anything scanning text it
    // is indistinguishable from a `<HTMLDivElement>` tag. This repo has nine
    // of them.
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { useRef } from "react";
import { Fragment } from "react";
import { Panel } from "../../components/Panel";
export default function OneScreen() {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref}><Fragment><Panel /></Fragment></div>;
}
`,
      [`${ROOT}/src/components/Panel.tsx`]: `
export function Panel() {
  return <section />;
}
`,
    });
    expect(index.components.map((c) => c.name)).toEqual(["OneScreen", "Panel"]);
  });

  it("keeps the declared name when the import was renamed, and records the alias", () => {
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import Pin from "../../components/Location";
export default function OneScreen() {
  return <Pin cls="x" />;
}
`,
      [`${ROOT}/src/components/Location.tsx`]: `
export default function LocationPin({ cls }: { cls: string }) {
  return <svg className={cls} />;
}
`,
    });
    const pin = get(index, "LocationPin");
    expect(pin.exported).toBe("default");
    expect(pin.aliases).toEqual(["Pin"]);
    expect(pin.instances[0]?.tag).toBe("Pin");
  });

  it("says when a reachable component is not exported at all", () => {
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: `
import { List } from "../../components/List";
export default function OneScreen() {
  return <List />;
}
`,
      [`${ROOT}/src/components/List.tsx`]: `
export function List() {
  return <ul><Row /></ul>;
}
function Row() {
  return <li />;
}
`,
    });
    expect(get(index, "List").exported).toBe("named");
    expect(get(index, "Row").exported).toBe("local");
  });
});

describe("instances", () => {
  it("points column at the `<` of the tag, the way React's stack frames do", () => {
    const source = `
import { Card } from "../../components/Card";
export default function OneScreen() {
  return (
    <div>
      <Card />
    </div>
  );
}
`;
    const index = build({
      [`${SCREENS}/one/screen.tsx`]: source,
      [`${ROOT}/src/components/Card.tsx`]: `export function Card() { return <div />; }`,
    });
    const at = get(index, "Card").instances[0];
    expect(at.file).toBe(`${LAB_PACKAGE_DIR}/src/screens/one/screen.tsx`);
    // Read the source back at the coordinates it produced, exactly as the
    // inspect plugin's test does. A plausible line number is not a location.
    const line = source.split("\n")[at.line - 1];
    expect(line.slice(at.column - 1).startsWith("<Card")).toBe(true);
  });
});
