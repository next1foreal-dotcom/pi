/**
 * A tiny real component tree for the plugin test, in a .tsx file so React's
 * JSX runtime captures real source locations AND the index builder has real
 * source to read. The test builds the index from this very file and then
 * renders it, which is the only way to prove the two halves join: the
 * compiler's idea of where `<Row/>` is written and React's idea of what made
 * a given node have to be the same coordinates.
 *
 * The line numbers below are load-bearing. Do not reformat.
 */

export function Row({ label, tone = "quiet" }: { label: string; tone?: "quiet" | "loud" }) {
  return (
    <div className="cx-row" data-tone={tone}>
      <span className="cx-label">{label}</span>
    </div>
  );
}

/** Rendered from a `.map()`: one tag site in the source, three on the canvas. */
export function Chip({ text }: { text: string }) {
  return <b className="cx-chip">{text}</b>;
}

/**
 * Recursive, so one tag site renders NESTED copies of itself. This is the case
 * that separates "an outline per element" from "an outline per source line":
 * the two inner trees share a tag site, and one contains the other.
 */
export function Tree({ depth }: { depth: number }) {
  return (
    <div className="cx-tree">{depth > 0 ? <Tree depth={depth - 1} /> : null}</div>
  );
}

export default function ProbePanel() {
  return (
    <section className="cx-panel">
      <Row label="one" />
      <Row label="two" />
      {["a", "b", "c"].map((t) => (
        <Chip key={t} text={t} />
      ))}
      <Tree depth={2} />
    </section>
  );
}
