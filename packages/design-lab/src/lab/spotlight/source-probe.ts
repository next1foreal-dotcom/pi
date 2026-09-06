/**
 * The spotlight's view of "which line of JSX made this element".
 *
 * This file used to be a second, independent implementation of the fiber walk,
 * and it was the unproven one: every test drove a hand-built fiber carrying a
 * hand-written stack string, so the mechanism was never once exercised against
 * a real React render. Measured side by side on the same rendered element it
 * also disagreed with the resolver that had been — it parsed specs with
 * `new URL()`, and `new URL("D:/a/b")` does not throw: it reads `d:` as a
 * protocol and hands back `/a/b`, quietly eating the drive letter. On the same
 * button, the two produced:
 *
 *     packages/design-lab/src/lab/plugins/inspect/probe-fixture.tsx:9:7
 *     @Her/Her-repo/samantha/packages/design-lab/src/lab/…/probe-fixture.tsx:9:7
 *
 * So this is now an adapter over the one resolver. Two things change for
 * callers, both deliberately: paths are repo-relative rather than relative to
 * this package, and the frame chosen is the first outside node_modules — the
 * tag that actually made the pixel — rather than the nearest frame under
 * `src/screens/`, which named the screen even when a shared component drew it.
 *
 * `SourceRef` stays as the spotlight's shape so `pick.ts` does not care.
 *
 * One thing worth knowing about the null: in the browser a location is only
 * complete once the served module's source map has been read, because the
 * stack's line and column are coordinates in what vite built rather than in
 * the file. `locateElement` starts that read on the first miss and reports
 * `source-map-pending` meanwhile, so the first call for a freshly served
 * module can answer null and the next one answers properly. Null, and not the
 * unmapped numbers: a chip that names the wrong line, or a note pinned to it,
 * is worse than one that names none. The inspect plugin reads the maps for the
 * whole tree when it mounts and after every hot update, so the pending window
 * is normally over before anyone points at anything.
 */

import { locateElement } from "../plugins/inspect/source-location";

export interface SourceRef {
  file: string;
  line: number;
  col: number;
  component: string | null;
}

/** The JSX that made `el`, or null when it cannot be known. Never throws. */
export function sourceOf(el: Element): SourceRef | null {
  const located = locateElement(el);
  if (located.problem !== null) return null;
  if (located.file === null || located.line === null || located.column === null) {
    return null;
  }
  return {
    file: located.file,
    line: located.line,
    col: located.column,
    component: located.component,
  };
}
