import type { CSSProperties, ReactNode } from "react";
import "../styles/tile.css";

/**
 * A block with a meter under it — the lab's own worked example of a component
 * whose props are levers.
 *
 * It exists so the properties panel has something to turn. Everything else on
 * this canvas passes its props as expressions (`product={product}`,
 * `title={LABELS[id]}`), which the source editor refuses to overwrite and
 * should refuse: a knob that rewrote `{...}` would be throwing away code. So
 * the panel had controls and nothing to point them at. This is the other end.
 *
 * Every prop below is here because there is a second value someone would want:
 * a distance, a count, a curated set of three, a switch, and one colour that
 * appears in two places at once and has to move together. The copy is NOT a
 * prop — it is `children`, written as literal text at the call site, so it is
 * edited where it is printed rather than through a string box three clicks
 * away. That is the rule in her-design/process/to-code.md ("A knob is a
 * lever"), and this component is meant to be the example of it, not the
 * counter-example.
 */
type Props = {
	/** @editor range min=0 max=48 step=4 unit=px section=Spacing */
	gap?: number;
	/** @editor boolean section=Spacing */
	dense?: boolean;
	/** @editor int min=1 max=12 section=Meter */
	ticks?: number;
	/** @editor enum section=Look */
	tone?: "quiet" | "loud" | "warning";
	/** @editor color section=Look */
	accent?: string;
	/** The copy. Deliberately not a prop with an editor — see the note above. */
	children?: ReactNode;
};

/** A tick's weight, so the meter reads as a ramp rather than a row of bars. */
function tickHeight(index: number, total: number): string {
	const t = total <= 1 ? 1 : index / (total - 1);
	return `${Math.round(6 + t * 18)}px`;
}

export default function Tile({
	gap = 16,
	dense = false,
	ticks = 5,
	tone = "quiet",
	accent = "#1c1c1c",
	children,
}: Props) {
	const count = Math.min(12, Math.max(1, Math.round(ticks)));
	const marks = Array.from({ length: count }, (_, i) => i);
	const style = {
		"--tl-gap": `${gap}px`,
		"--tl-accent": accent,
	} as CSSProperties;

	return (
		<section
			className="tl-tile"
			data-tone={tone}
			data-dense={dense ? "on" : "off"}
			style={style}
		>
			<div className="tl-body">{children}</div>
			<div className="tl-meter" aria-hidden="true">
				{marks.map((i) => (
					<span
						className="tl-tick"
						key={`tick-${i}`}
						style={{ height: tickHeight(i, count) }}
					/>
				))}
			</div>
		</section>
	);
}
