/**
 * A tiny real component rendered by the probe test. Its only job is to exist in
 * a .tsx file so React's JSX runtime captures a source location we can assert
 * against — the line numbers below are load-bearing, so do not reformat.
 */
export function ProbeCard() {
  return (
    <div className="probe-card" data-probe="card">
      <button type="button" className="probe-button">
        Buy now
      </button>
    </div>
  );
}
