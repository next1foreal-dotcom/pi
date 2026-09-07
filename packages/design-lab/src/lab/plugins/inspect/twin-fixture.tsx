/**
 * Two tags on ONE line, so a lookup that matches only file and line can be
 * caught doing it. The line and columns below are load-bearing — do not
 * reformat, and do not add anything above `TwinRow`.
 */
export function TwinRow() {
  return (
    <div className="twin-row"><span className="twin-a">A</span><span className="twin-b">B</span></div>
  );
}
